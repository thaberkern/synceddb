// SyncedDB
'use strict';

// Minivents
// https://github.com/allouis/minivents
function Events(target){
  var events = {};
  target = target || this;
  // On: listen to events
  target.on = function(type, func, ctx){
    (events[type] = events[type] || []).push({f:func, c:ctx});
  };
  // Off: stop listening to event / specific callback
  target.off = function(type, func){
    type || (events = {});
    var list = events[type] || [],
    i = list.length = func ? list.length : 0;
    while(i-->0) func == list[i].f && list.splice(i,1);
  };
  // Emit: send event, callbacks will be triggered
  target.emit = function(){
    var args = Array.apply([], arguments),
    list = events[args.shift()] || [], i=0, j;
    for(;j=list[i++];) j.f.apply(j.c, args);
  };
}

// Utility functions

function toArray(arr) {
  return [].slice.call(arr);
}

function eachKeyVal(obj, fn) {
  Object.keys(obj).forEach(function(key) { fn(key, obj[key]); });
}

function partial() {
  return Function.bind.apply(arguments[0], arguments);
}

function isObject(o) {
  return o !== null && typeof o === 'object';
}

function isString(s) {
  return typeof s === 'string';
}

function isNum(n) {
  return typeof n === 'number';
}

function isFunc(f) {
  return typeof f === 'function';
}

function isUndef(x) {
  return x === undefined;
}

function isKey(k) {
  return isString(k) || isNum(k);
}

function copyRecord(obj) {
  return JSON.parse(JSON.stringify(obj));
}

function copyWithoutMeta(rec) {
  var r = copyRecord(rec);
  delete r.remoteOriginal;
  delete r.version;
  delete r.changedSinceSync;
  return r;
}

function extractKey(pk) {
  var k = isObject(pk) ? pk.key : pk;
  if (!isKey(k)) throw new TypeError(k + ' is not a valid key');
  return k;
}

function Countdown(initial) {
  this.val = initial || 0;
}
Countdown.prototype.add = function(n) {
  this.val += n;
  if (this.val === 0) this.onZero();
};

function WrappedSocket(url, protocol) {
  var wws = this;
  Events(wws);
  var ws = this.ws = new WebSocket(url, protocol);
  ws.onopen = function () {
    console.log('Connection open');
    wws.emit('open');
  };
  ws.onerror = function (error) {
    console.log('Connection errror');
    console.log(error);
    wws.emit('error', error);
  };
  ws.onclose = function (e) {
    console.log('Connection closed');
    console.log(e);
    wws.emit('close', e);
  };
  ws.onmessage = function(msg) {
    console.log('Message recieved');
    var data;
    if (isString(msg.data)) {
      data = JSON.parse(msg.data);
    } else {
      data = msg.data;
    }
    console.log(data);
    wws.emit('message', data);
  };
}

WrappedSocket.prototype.send = function(msg) {
  if (isObject(msg)) {
    this.ws.send(JSON.stringify(msg));
  } else {
    this.ws.send(msg);
  }
};

WrappedSocket.prototype.close = function() {
  this.ws.close.apply(this.ws, arguments);
};

function handleVersionChange(e) {
  // The database is being deleted or opened with
  // a newer version, possibly in another tab
  e.target.close();
}

var SDBIndex = function(name, db, store) {
  this.name = name;
  this.db = db;
  this.store = store;
};

function doIndexGet(idx, ranges, tx, resolve, reject) {
  var records = [];
  var index = idx.store.IDBStore.index(idx.name);
  var rangesLeft = new Countdown(ranges.length);
  rangesLeft.onZero = partial(resolve, records);
  ranges.forEach(function(range) {
    var req = index.openCursor(range);
    req.onsuccess = function() {
      var cursor = req.result;
      cursor ? (records.push(cursor.value), cursor.continue())
             : rangesLeft.add(-1);
    };
  });
}

SDBIndex.prototype.get = function(/* ranges */) {
  var index = this;
  var ranges = toArray(arguments).map(IDBKeyRange.only);
  return doInStoreTx('readonly', index.store, function(tx, resolve, reject) {
    return doIndexGet(index, ranges, tx, resolve, reject);
  });
};

SDBIndex.prototype.getAll = function() {
  var index = this;
  return doInStoreTx('readonly', index.store, function(tx, resolve, reject) {
    return doIndexGet(index, [undefined], tx, resolve, reject);
  });
};
SDBIndex.prototype.inRange = function(/* ranges */) {
  var index = this;
  var ranges = toArray(arguments).map(createKeyRange);
  return doInStoreTx('readonly', index.store, function(tx, resolve, reject) {
    return doIndexGet(index, ranges, tx, resolve, reject);
  });
};

function setStoreTx(store, tx) {
  store.tx = tx;
  store.IDBStore = tx.objectStore(store.name);
  tx.addEventListener('abort', function() {
    store.tx = undefined;
  });
  tx.addEventListener('complete', function() {
    store.tx = undefined;
    emitChangeEvents(store.changedRecords, store.db.stores[store.name]);
    store.changedRecords.length = 0;
  });
}

var SDBObjectStore = function(db, name, indexes, tx) {
  var store = this;
  store.name = name;
  store.db = db;
  store.indexes = indexes;
  store.changedRecords = [];
  store.messages = new Events();
  Events(store);
  indexes.forEach(function(i) {
    store[i] = new SDBIndex(i, db, store);
  });
  if (tx) setStoreTx(store, tx);
};

function doGet(IDBStore, key, getDeleted) {
  return new SyncPromise(function(resolve, reject) {
    var req = IDBStore.get(key);
    req.onsuccess = function() {
      if (!isUndef(req.result) &&
          (!req.result.deleted || getDeleted)) {
        resolve(req.result);
      } else {
        reject({type: 'KeyNotFoundError', key: key});
      }
    };
  });
}

SDBObjectStore.prototype.get = function(/* keys */) {
  var store = this;
  var keys = toArray(arguments);
  return doInStoreTx('readonly', store, function(tx, resolve, reject) {
    var gets = keys.map(partial(doGet, store.IDBStore));
    SyncPromise.all(gets).then(function(records) {
      if (keys.length === records.length)
        resolve(keys.length == 1 ? records[0] : records);
    })
    .catch(function(err) { reject(err); });
  });
};

SDBObjectStore.prototype.delete = function(/* keys */) {
  var store = this;
  var args = toArray(arguments);
  return doInStoreTx('readwrite', store, function(tx, resolve, reject) {
    var deletes = args.map(function(key) {
      return deleteFromStore(store, extractKey(key), 'LOCAL');
    });
    SyncPromise.all(deletes).then(resolve).catch(reject);
  });
};

function doInStoreTx(mode, store, cb) {
  if (store.tx) { // We're in transaction
    return (new SyncPromise(function(resolve, reject) {
      cb(store.tx, resolve, reject);
    }));
  } else {
    return store.db.then(function() {
      var tx = store.db.db.transaction(store.name, mode);
      setStoreTx(store, tx);
      return new Promise(function(resolve, reject) {
        var val, rejected;
        cb(tx, function(v) {
          val = v;
          rejected = false;
        }, function(v) {
          val = v;
          rejected = true;
        });
        tx.oncomplete = function() {
          rejected ? reject(val) : resolve(val);
        };
      });
    });
  }
}

function doPutRecord(store, record) {
  record.changedSinceSync = 1;
  return new SyncPromise(function(resolve, reject) {
    if (!isUndef(record.key)) { // Update existing record
      doGet(store.IDBStore, record.key).then(function(oldRecord) {
        record.version = oldRecord.version;
        if (oldRecord.changedSinceSync === 0) {
          record.remoteOriginal = copyWithoutMeta(oldRecord);
        }
        putValToStore(store, record, 'LOCAL').then(resolve);
      });
    } else { // Add new record
      record.key = Math.random().toString(36);
      addRecToStore(store, record, 'LOCAL').then(resolve);
    }
  });
}

SDBObjectStore.prototype.put = function(/* recs */) {
  var recs = toArray(arguments);
  var store = this;
  return doInStoreTx('readwrite', store, function(tx, resolve, reject) {
    var puts = recs.map(partial(doPutRecord, store));
    SyncPromise.all(puts).then(resolve);
  });
};

function emitChangeEvents(changes, dbStore) {
  changes.forEach(function(change) {
    dbStore.emit(change.type, {
      record: change.record,
      origin: change.origin
    });
    if (dbStore.db.continuousSync && change.origin !== 'REMOTE') {
      sendChangeToRemote(dbStore.db.ws, dbStore.name, change.record);
    }
  });
}

function insertValInStore(method, store, val, origin) {
  var IDBStore = store.IDBStore;
  return new SyncPromise(function(resolve, reject) {
    var req = IDBStore[method](val);
    req.onsuccess = function() {
      var type = method === 'add' ? 'add' : 'update';
      if (origin !== 'INTERNAL')
        store.changedRecords.push({type: type, origin: origin, record: val});
      resolve(req.result);
    };
  });
}

var putValToStore = partial(insertValInStore, 'put');
var addRecToStore = partial(insertValInStore, 'add');

function createTombstone(r) {
  return {
    version: r.version,
    key: r.key,
    changedSinceSync: 1,
    deleted: true,
    remoteOriginal: r.remoteOriginal || copyWithoutMeta(r),
  };
}

function deleteFromStore(store, key, origin) {
  var IDBStore = store.IDBStore;
  return new SyncPromise(function(resolve, reject) {
    doGet(IDBStore, key, true).then(function(record) {
      var tombstone = createTombstone(record);
      store.changedRecords.push({type: 'delete', origin: origin, record: tombstone});
      if ((record.changedSinceSync === 1 && !record.remoteOriginal)
          || origin === 'REMOTE') {
        var req = store.IDBStore.delete(key);
        req.onsuccess = resolve;
      } else {
        putValToStore(store, tombstone, 'INTERNAL').then(resolve);
      }
    });
  });
}

var createKeyRange = function(r) {
  var gt   = 'gt' in r,
      gte  = 'gte' in r,
      lt   = 'lt' in r,
      lte  = 'lte' in r,
      low  = gt ? r.gt : r.gte,
      high = lt ? r.lt : r.lte;
  return !gt && !gte ? IDBKeyRange.upperBound(high, lt)
       : !lt && !lte ? IDBKeyRange.lowerBound(low, gt)
                     : IDBKeyRange.bound(low, high, gt, lt);
};

function callMigrationHooks(data, migrations, newV, curV) {
  while(curV++ < newV)
    if (isFunc(migrations[curV]))
      migrations[curV](data.db, data.e);
}

var handleMigrations = function(version, storeDeclaration, migrationHooks, e) {
  var req = e.target;
  var db = req.result;
  var existingStores = db.objectStoreNames;
  var metaStore;
  if (existingStores.contains('sdbMetaData')) {
    metaStore = req.transaction.objectStore('sdbMetaData');
  } else {
    metaStore = db.createObjectStore('sdbMetaData', {keyPath: 'key'});
    metaStore.put({key: 'meta'});
  }
  eachKeyVal(storeDeclaration, function(storeName, indexes) {
    var store;
    if (existingStores.contains(storeName)) {
      store = req.transaction.objectStore(storeName);
    } else {
      store = db.createObjectStore(storeName, {keyPath: 'key'});
      metaStore.put({key: storeName + 'Meta', syncedTo: null});
    }
    indexes.forEach(function(index) {
      if (!store.indexNames.contains(index[0]))
        store.createIndex.apply(store, index);
    });
  });
  if (migrationHooks)
    callMigrationHooks({db: db, e: e}, migrationHooks, version, e.oldVersion);
};

var SDBDatabase = function(opts) {
  var db = this;
  Events(db);
  db.name = opts.name;
  db.remote = opts.remote;
  db.version = opts.version;
  db.recordsToSync = new Countdown();
  db.changesLeftFromRemote = new Countdown();
  db.messages = new Events();
  db.stores = {};
  var stores = {};
  eachKeyVal(opts.stores, function(storeName, indexes) {
    stores[storeName] = indexes.concat([['changedSinceSync', 'changedSinceSync']]);
  });
  // Create stores on db object
  eachKeyVal(stores, function(storeName, indexes) {
    var indexNames = indexes.map(function(idx) { return idx[0]; });
    var storeObj = new SDBObjectStore(db, storeName, indexNames);
    db.stores[storeName] = storeObj;
    // Make stores available directly as properties on the db
    // Store shortcut should not override db properties
    db[storeName] = db[storeName] || storeObj;
  });
  db.sdbMetaData = new SDBObjectStore(db, 'sdbMetaData', []);
  this.promise = new Promise(function(resolve, reject) {
    var req = indexedDB.open(db.name, db.version);
    req.onupgradeneeded = partial(handleMigrations, db.version, stores, opts.migrations);
    req.onsuccess = function(e) {
      db.db = req.result;
      db.db.onversionchange = handleVersionChange;
      resolve({db: db, e: e});
    };
  });
  return db;
};

SDBDatabase.prototype.then = function(fn) {
  return this.promise.then(fn);
};
SDBDatabase.prototype.catch = function(fn) {
  return this.promise.catch(fn);
};

SDBDatabase.prototype.transaction = function(storeNames, mode, fn) {
  storeNames = [].concat(storeNames);
  mode = mode === 'r'    ? 'readonly'
       : mode === 'read' ? 'readonly'
       : mode === 'rw'   ? 'readwrite'
                         : mode;
  var db = this;
  return db.then(function(res) {
    return new Promise(function(resolve, reject) {
      var tx = db.db.transaction(storeNames, mode);
      var stores = storeNames.map(function(s) {
        var store = s === 'sdbMetaData' ? db[s] : db.stores[s];
        return (new SDBObjectStore(db, s, store.indexes, tx));
      });
      tx.oncomplete = resolve;
      fn.apply(null, stores);
    });
  });
};

SDBDatabase.prototype.read = function() {
  var args = toArray(arguments), fn = args.pop();
  return this.transaction(args, 'r', fn);
};

SDBDatabase.prototype.write = function() {
  var args = toArray(arguments), fn = args.pop();
  return this.transaction(args, 'rw', fn);
};

var createMsg = function(storeName, record) {
  var r = copyWithoutMeta(record);
  delete r.key;
  return {
    type: 'create',
    storeName: storeName,
    record: r,
    key: record.key,
  };
};

var updateMsg = function(storeName, record) {
  var remoteOriginal = record.remoteOriginal;
  delete record.remoteOriginal; // Noise free diff
  remoteOriginal.version = record.version;
  remoteOriginal.changedSinceSync = 1;
  var diff = dffptch.diff(remoteOriginal, record);
  record.remoteOriginal = remoteOriginal;
  return {
    type: 'update',
    storeName: storeName,
    version: record.version,
    diff: diff,
    key: record.key,
  };
};

var deleteMsg = function(storeName, record) {
  return {
    type: 'delete',
    storeName: storeName,
    key: record.key,
    version: record.version,
  };
};

function sendChangeToRemote(ws, storeName, record) {
  var msgFunc = record.deleted        ? deleteMsg
              : record.remoteOriginal ? updateMsg
                                      : createMsg;
  ws.send(msgFunc(storeName, record));
}

function updateStoreSyncedTo(metaStore, storeName, time) {
  metaStore.get(storeName + 'Meta').then(function(storeMeta) {
    storeMeta.syncedTo = time;
    putValToStore(metaStore, storeMeta, 'INTERNAL');
  });
}

function requestChangesToStore(db, ws, storeName) {
  db.sdbMetaData.get(storeName + 'Meta').then(function(storeMeta) {
    ws.send({
      type: 'get-changes',
      storeName: storeName,
      since: storeMeta.syncedTo,
    });
  });
}

function handleRemoteChange(db, storeName, cb) {
  return db.write(storeName, 'sdbMetaData', cb).then(function() {
    db.changesLeftFromRemote.add(-1);
  });
}

var handleIncomingMessageByType = {
  'sending-changes': function(db, ws, msg) {
    db.emit('sync-initiated', msg);
    db.changesLeftFromRemote.add(msg.nrOfRecordsToSync);
  },
  'create': function(db, ws, msg) {
    msg.record.changedSinceSync = 0;
    msg.record.key = msg.key;
    msg.record.version = msg.version;
    handleRemoteChange(db, msg.storeName, function(store, metaStore) {
      addRecToStore(store, msg.record, 'REMOTE').then(function() {
        updateStoreSyncedTo(metaStore, msg.storeName, msg.timestamp);
      });
    });
  },
  'update': function(db, ws, msg) {
    handleRemoteChange(db, msg.storeName, function(store, metaStore) {
      doGet(store.IDBStore, msg.key, true).then(function(local) {
        if (local.changedSinceSync === 1) { // Conflict
          var original = local.remoteOriginal;
          var remote = copyRecord(original);
          remote.version = local.version;
          remote.changedSinceSync = 1;
          dffptch.patch(remote, msg.diff);
          local.remoteOriginal = remote;
          var resolved = db.stores[msg.storeName].handleConflict(original, local, remote);
          return putValToStore(store, resolved, 'LOCAL');
        } else {
          dffptch.patch(local, msg.diff);
          local.version = msg.version;
          return putValToStore(store, local, 'REMOTE');
        }
      }).then(function() {
        updateStoreSyncedTo(metaStore, msg.storeName, msg.timestamp);
      });
    });
  },
  'delete': function(db, ws, msg) {
    handleRemoteChange(db, msg.storeName, function(store, metaStore) {
      doGet(store.IDBStore, msg.key, true).then(function(local) {
        if (local.changedSinceSync === 1 && !local.deleted) {
          var original = local.remoteOriginal;
          var remote = {deleted: true, key: msg.key};
          local.remoteOriginal = remote;
          var resolved = db.stores[msg.storeName].handleConflict(original, local, remote);
          resolved.deleted ? deleteFromStore(store, msg.key, 'REMOTE')
                           : putValToStore(store, resolved, 'LOCAL');
        } else {
          deleteFromStore(store, msg.key, 'REMOTE');
        }
      }).then(function() {
        updateStoreSyncedTo(metaStore, msg.storeName, msg.timestamp);
      });
    });
  },
  'ok': function(db, ws, msg) {
    var record;
    db.write(msg.storeName, 'sdbMetaData', function(store, metaStore) {
      doGet(store.IDBStore, msg.key, true).then(function(rec) {
        record = rec;
        if (record.deleted) {
          store.IDBStore.delete(msg.key);
        } else {
          record.changedSinceSync = 0;
          record.version = msg.newVersion;
          delete record.remoteOriginal;
          if (!isUndef(msg.newKey)) {
            record.key = msg.newKey;
            store.IDBStore.delete(msg.key);
          }
          putValToStore(store, record, 'INTERNAL');
        }
      }).then(function() {
        updateStoreSyncedTo(metaStore, msg.storeName, msg.timestamp);
      });
    }).then(function() {
      db.stores[msg.storeName].emit('synced', msg.key, record);
      db.recordsToSync.add(-1);
    });
  },
  'reject': function(db, ws, msg) {
    if (!isKey(msg.key)) {
      throw new Error('Reject message recieved from remote without key property');
    }
    var f = isString(msg.storeName) ? db.stores[msg.storeName].handleReject
                                    : db.handleReject;
    if (!isFunc(f)) {
      throw new Error('Reject message recieved from remote but no reject handler is supplied');
    }
    db.stores[msg.storeName].get(msg.key).then(function(record) {
      return f(record, msg);
    }).then(function(record) {
      record ? sendChangeToRemote(ws, msg.storeName, record)
             : db.recordsToSync.add(-1); // Skip syncing record
    });
  },
};

function handleIncomingMessage(db, msg) {
  var handler = handleIncomingMessageByType[msg.type];
  var target = isString(msg.storeName) ? db.stores[msg.storeName].messages
                                       : db.messages;
  isFunc(handler) ? handler(db, db.ws, msg)
                  : target.emit(msg.type, msg);
}

function doPullFromRemote(ctx) {
  return new Promise(function(resolve, reject) {
    ctx.db.changesLeftFromRemote.onZero = partial(resolve, ctx);
    ctx.storeNames.map(partial(requestChangesToStore, ctx.db, ctx.db.ws));
  });
}

function sendRecordsChangedSinceSync(ctx) {
  return ctx.db.transaction(ctx.storeNames, 'r', function() {
    var stores = toArray(arguments);
    var gets = stores.map(function(store) { 
      return store.changedSinceSync.get(1);
    });
    SyncPromise.all(gets).then(function(results) {
      var total = results.reduce(function(sum, recs, i) {
        recs.forEach(partial(sendChangeToRemote, ctx.db.ws, stores[i].name));
        return sum + recs.length;
      }, 0);
      ctx.db.recordsToSync.add(total);
    });
  });
}

function doPushToRemote(ctx) {
  return new Promise(function(resolve, reject) {
    ctx.db.recordsToSync.onZero = partial(resolve, ctx);
    sendRecordsChangedSinceSync(ctx);
  });
}

function getWs(db) {
  if (!db.wsPromise) {
    db.wsPromise = new Promise(function(resolve, reject) {
      db.ws = new WrappedSocket('ws://' + db.remote);
      db.ws.on('message', partial(handleIncomingMessage, db));
      db.ws.on('open', function() {
        resolve(db.ws);
      });
    });
  }
  return db.wsPromise;
}

function getSyncContext(db, storeNamesArgs) {
  if (db.syncing) {
    return Promise.reject({type: 'AlreadySyncing'});
  }
  db.syncing = true;
  var storeNames = storeNamesArgs.length ? toArray(storeNamesArgs) : Object.keys(db.stores);
  return db.then(function() {
    return getWs(db);
  }).then(function(ws) {
    return {db: db, storeNames: storeNames};
  });
}

function closeSyncContext(ctx) {
  ctx.db.syncing = false;
  ctx.db.disconnect();
}

SDBDatabase.prototype.connect = function() {
  var db = this;
  return db.then(function() {
    return getWs(db).then(function(){});
  });
};

SDBDatabase.prototype.disconnect = function() {
  if (this.ws) {
    this.ws.close();
    this.wsPromise = null;
  }
};

SDBDatabase.prototype.send = function(msg) {
  return getWs(this).then(function(ws) {
    ws.send(msg);
  });
};

SDBDatabase.prototype.pushToRemote = function(/* storeNames */) {
  return getSyncContext(this, arguments)
  .then(doPushToRemote)
  .then(closeSyncContext);
};

SDBDatabase.prototype.pullFromRemote = function(/* storeNames */) {
  return getSyncContext(this, arguments)
  .then(doPullFromRemote)
  .then(closeSyncContext);
};

function doSync(db, continuously, storeNames) {
  return getSyncContext(db, storeNames)
  .then(doPullFromRemote)
  .then(doPushToRemote)
  .then(function(ctx) {
    continuously ? db.continuousSync = true
                 : closeSyncContext(ctx);
  });
}

SDBDatabase.prototype.sync = function(/* storeNames */) {
  return doSync(this, false, arguments);
};

SDBDatabase.prototype.syncContinuously = function(/* storeNames */) {
  return doSync(this, true, arguments);
};

exports.open = function(opts) {
  return new SDBDatabase(opts);
};
