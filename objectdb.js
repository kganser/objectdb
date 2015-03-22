// Copyright 2014, Klaus Ganser <http://kganser.com>
// MIT Licensed, with this copyright and permission notice
// <http://opensource.org/licenses/MIT>

var objectDB = function() {

  var makeKey = function(path) {
    var key = path.length ? path[path.length-1] : '';
    return [path.length < 2 && !key ? 0 : path.slice(0, -1).map(encodeURIComponent).join('/'), key];
  };
  var scopedRange = function(parent, lower, upper, le, ue) {
    parent = parent.map(encodeURIComponent).join('/');
    ue = upper == null || ue;
    lower = lower == null ? [parent] : [parent, lower];
    upper = upper == null ? [parent+'\0'] : [parent, upper];
    return IDBKeyRange.bound(lower, upper, le, ue);
  };
  var resolvePath = function(store, path, callback) {
    // substitute array indices in path with numeric keys;
    // second argument to callback is true if path is an empty array slot
    path = path ? path.split('/').map(decodeURIComponent) : [];
    (function advance(i, empty) {
      while (i < path.length && !/0|[1-9][0-9]*/.test(path[i])) i++;
      if (i == path.length) return callback(path, empty);
      var position = parseInt(path[i]);
      store.get(makeKey(path.slice(0, i))).onsuccess = function(e) {
        var result = e.target.result;
        if (!result) return callback(path, empty);
        if (result.type != 'array') return advance(i+1);
        // set to numeric index initially, and to key if element is found
        path[i] = position;
        store.openCursor(scopedRange(path.slice(0, i))).onsuccess = function(e) {
          var cursor = e.target.result;
          if (cursor && position) {
            cursor.advance(position);
            position = 0;
          } else {
            if (cursor) path[i] = cursor.value.key;
            advance(i+1, !cursor);
          }
        };
      };
    }(0));
  };
  var get = function(store, path, callback, cursor) {
    var next;
    if (typeof cursor != 'function') cursor = function() {};
    store.get(makeKey(path)).onsuccess = function(e) {
      var result = e.target.result;
      if (!result) return next || callback();
      (next = function(result, parent, path, callback) {
        var value = result.value,
            type = result.type,
            pending = 1,
            index = 0;
        if (type != 'object' && type != 'array')
          return callback(value);
        var array = type == 'array',
            c = cursor(path, array);
        value = array ? [] : {};
        if (c === false) return callback(value);
        if (!c || typeof c != 'object') c = {action: c || {}};
        if (typeof c.action != 'function') c.action = function() {};
        store.openCursor(
          scopedRange(parent, c.lowerBound, c.upperBound, c.lowerExclusive, c.upperExclusive),
          c.descending ? 'prev' : 'next'
        ).onsuccess = function(e) {
          var cursor = e.target.result;
          if (!cursor) return --pending || callback(value);
          var result = cursor.value,
              key = array ? index++ : result.key,
              action = c.action(key);
          if (action == 'stop') return --pending || callback(value);
          if (action != 'skip') {
            value[key] = pending++;
            next(result, parent.concat([result.key]), path.concat([key]), function(child) {
              value[key] = child;
              if (!--pending) callback(value);
            });
          }
          cursor.continue();
        };
      })(result, path, [], callback);
    };
  };
  var put = function(store, path, value, callback) {
    // { key: (key or index relative to parent)
    //   parent: (path of parent entry)
    //   type: (string|number|boolean|null|array|object)
    //   value: (or null if array or object) }
    var type = Array.isArray(value) ? 'array' : typeof value == 'object' ? value ? 'object' : 'null' : typeof value,
        key = makeKey(path),
        pending = 1,
        cb = function() { if (!--pending) callback(); };
    store.put({parent: key[0], key: key[1], type: type, value: typeof value == 'object' ? null : value}).onsuccess = cb;
    if (type == 'array') {
      value.forEach(function(value, i) {
        pending++;
        put(store, path.concat([i]), value, cb);
      });
    } else if (type == 'object') {
      Object.keys(value).forEach(function(key) {
        pending++;
        put(store, path.concat([key]), value[key], cb);
      });
    }
  };
  var append = function(store, path, value, callback) {
    store.openCursor(scopedRange(path), 'prev').onsuccess = function(e) {
      var cursor = e.target.result;
      put(store, path.concat([cursor ? cursor.value.key+1 : 0]), value, callback);
    };
  };
  var deleteChildren = function(store, path, callback) {
    var pending = 1,
        cb = function() { if (!--pending) callback(); };
    store.openCursor(scopedRange(path)).onsuccess = function(e) {
      var cursor = e.target.result;
      if (!cursor) return cb();
      var result = cursor.value;
      pending++;
      store.delete([result.parent, result.key]).onsuccess = cb;
      if (result.type == 'object' || result.type == 'array') {
        pending++;
        deleteChildren(store, path.concat([result.key]), cb);
      }
      cursor.continue();
    }
  };
  
  return {
    open: function(database, upgrade, version, onError) {
    /** objectDB: {
          open: function(database:string, upgrade=`{}`:json|function(UpgradeTransaction), version=1:number, onError=undefined:function(error:DOMError, blocked:boolean)) -> Database,
          delete: function(database:string, callback:function(error:undefined|DOMError, blocked:boolean)),
          list: function(callback:function(DOMStringList))
        }
        
        ObjectDB is backed by `indexedDB`. An upgrade transaction runs on `open` if the database version is less than
        the requested version or does not exist. If `upgrade` is a json value, the data stores in the first transaction
        operation on this `Database` will be populated with this value on an upgrade event. Otherwise, an upgrade will
        be handled by the given function via `UpgradeTransaction`. */
      var self, db, queue, close, open = function(stores, callback) {
        if (db) return callback();
        if (queue) return queue.push(callback);
        queue = [callback];
        var request = indexedDB.open(database, version || 1);
        request.onupgradeneeded = function(e) {
          var self, db = e.target.result,
              data = upgrade === undefined || typeof upgrade == 'function' ? {} : upgrade;
          if (typeof upgrade != 'function') upgrade = function(db) {
            (Array.isArray(stores) ? stores : [stores]).forEach(function(name) {
              db.createObjectStore(name, data);
            });
          };
          /** UpgradeTransaction: {
                oldVersion: number,
                newVersion: number,
                createObjectStore: function(name:string, data=`{}`:json) -> UpgradeTransaction,
                deleteObjectStore: function(name:string) -> UpgradeTransaction
              } */
          upgrade(self = {
            oldVersion: e.oldVersion,
            newVersion: e.newVersion,
            createObjectStore: function(name, data) {
              if (db.objectStoreNames.contains(name))
                throw 'objectStore already exists';
              put(db.createObjectStore(name, {keyPath: ['parent', 'key']}), [], data === undefined ? {} : data, function() {});
              return self;
            },
            deleteObjectStore: function(name) {
              if (db.objectStoreNames.contains(name))
                db.deleteObjectStore(name);
              return self;
            }
          });
        };
        request.onsuccess = function(e) {
          db = e.target.result;
          while (callback = queue.shift()) callback();
          if (close) {
            db.close();
            close = null;
          }
        };
        if (onError) {
          request.onerror = function(e) { onError(e.target.error, false); };
          request.onblocked = function() { onError(null, true); };
        }
      };
      var transaction = function(type, stores, callback) {
        var trans, pending = 0, values = [], self = {
          get: get,
          put: function(store, path, callback, value, insert, empty) {
            var parentPath = path.slice(0, -1);
            store.get(makeKey(parentPath)).onsuccess = function(e) {
              var parent = e.target.result,
                  key = path[path.length-1];
              if (!parent && path.length)
                return callback('Parent resource does not exist');
              if (insert && (!path.length || parent.type != 'array'))
                return callback('Parent resource is not an array');
              if (parent && parent.type != 'object' && parent.type != 'array')
                return callback('Parent resource is not an object or array');
              if (parent && parent.type == 'array' && typeof key != 'number')
                return callback('Invalid index to array resource');
              if (empty) { // array slot
                append(store, parentPath, value, callback);
              } else if (insert) {
                var i = 0, lastShiftKey = key;
                store.openCursor(scopedRange(parentPath, key)).onsuccess = function(e) {
                  var cursor = e.target.result;
                  if (cursor && cursor.value.key == key+i++) {
                    // all contiguous keys after desired position must be shifted by one
                    lastShiftKey = cursor.value.key;
                    return cursor.continue();
                  }
                  // found last key to shift; now shift subsequent elements' keys
                  var pending = 1,
                      cb = function() { if (!--pending) callback(); };
                  store.openCursor(scopedRange(parentPath, key, lastShiftKey), 'prev').onsuccess = function(e) {
                    cursor = e.target.result;
                    if (!cursor) return put(store, path, value, cb);
                    var index = cursor.value.key,
                        currentPath = parentPath.concat([index]);
                    pending++;
                    get(store, currentPath, function(result) { // TODO: delete/put within cursor
                      deleteChildren(store, currentPath, function() {
                        put(store, parentPath.concat([index+1]), result, cb);
                        cursor.continue();
                      });
                    });
                  };
                };
              } else {
                deleteChildren(store, path, function() {
                  put(store, path, value, callback);
                });
              }
            };
          },
          append: function(store, path, callback, value) {
            store.get(makeKey(path)).onsuccess = function(e) {
              var parent = e.target.result;
              if (!parent)
                return callback('Parent resource does not exist');
              if (parent.type != 'array')
                return callback('Parent resource is not an array');
              append(store, path, value, callback);
            };
          },
          delete: function(store, path, callback) {
            store.delete(makeKey(path));
            deleteChildren(store, path, callback);
          }
        };
        Object.keys(self).forEach(function(name) {
          var method = self[name];
          var wrapped = function(store, path, value, insert) {
            var i = values.push(pending++)-1, p = path;
            resolvePath(store = trans.objectStore(store), path, function(path, empty) {
              method(store, path, function(value) {
                values[i] = value;
                if (!--pending) {
                  var v = values;
                  values = [];
                  callback.apply(null, v);
                }
              }, value, insert, empty);
            });
          };
          self[name] = function(store, path, value, insert) {
            if (trans) return wrapped(store, path, value, insert);
            open(stores, function() {
              if (!trans) trans = db.transaction(stores, type);
              wrapped(store, path, value, insert);
            });
          };
        });
        return self;
      };
      /** Database: {
            transaction: function(writable=false:boolean, stores='data':[string, ...]|string) -> Transaction|ScopedTransaction,
            get: function(path='':string, writable=false:boolean, cursor=undefined:Cursor, store='data':string) -> ScopedTransaction,
            put: function(path='':string, value:json, store='data':string) -> ScopedTransaction,
            insert: function(path='':string, value:json, store='data':string) -> ScopedTransaction,
            append: function(path='':string, value:json, store='data':string) -> ScopedTransaction,
            delete: function(path='':string, store='data':string) -> ScopedTransaction,
            close: function
          }
          
          `get`, `put`, `insert`, `append`, and `delete` are convenience methods that operate through `transaction` for
          a single objectStore and return the corresponding `ScopedTransaction`. `get` initiates a read-only
          transaction by default. `transaction` returns a `ScopedTransaction` if a single (string) objectStore is
          specified, and a `Transaction` if operating on multiple objectStores. */
      return self = {
        transaction: function(writable, stores) {
          if (stores == null) stores = 'data';
          var self, cb, trans = transaction(writable ? 'readwrite' : 'readonly', stores, function() {
            if (cb) cb.apply(self, arguments);
          });
          /** Transaction: {
                get: function(store:string, path='':string, cursor=undefined:Cursor) -> Transaction,
                put: null|function(store:string, path='':string, value:json) -> Transaction,
                insert: null|function(store:string, path='':string, value:json) -> Transaction,
                append: null|function(store:string, path='':string, value:json) -> Transaction,
                delete: null|function(store:string, path='':string) -> Transaction,
                then: function(callback:function(this:Transaction, json|undefined, ...))
              }
              
              A `Transaction` acting on multiple data stores must specify a data store as the first argument to every
              operation. Otherwise, these methods correspond to `ScopedTransaction` methods. */
              
          /** ScopedTransaction: {
                get: function(path='':string, cursor=undefined:Cursor) -> ScopedTransaction,
                put: null|function(path='':string, value:json) -> ScopedTransaction,
                insert: null|function(path='':string, value:json) -> ScopedTransaction,
                append: null|function(path='':string, value:json) -> ScopedTransaction,
                delete: null|function(path='':string) -> ScopedTransaction,
                then: function(callback:function(this:ScopedTransaction, json|undefined, ...))
              }
              
              All methods except `then` are chainable and execute on the same transaction in parallel. If the
              transaction is not writable, `put`, `insert`, `append`, and `delete` are null.
              
              `path` is a `/`-separated string of array indices and `encodeURIComponent`-encoded object keys denoting
              the path to the desired element within the object store's json data structure; e.g.
              `'users/123/firstName'`. If undefined, `cursor` buffers all data at the requested path as the result of a
              `get` operation. `insert` will splice the given `value` into the parent array at the specified position,
              shifting any subsequent elements forward.
              
              When all pending operations complete, `callback` is called with the result of each queued operation in
              order. More operations can be queued onto the same transaction at that time via `this`.
              
              Results from `put`, `insert`, `append`, and `delete` are error strings or undefined if successful. `get`
              results are json data or undefined if no value exists at the requested path. */
              
          /** Cursor: function(path:[string|number, ...], array:boolean) -> boolean|Action|{
                lowerBound=null: string|number,
                lowerExclusive=false: boolean,
                upperBound=null: string|number,
                upperExclusive=false: boolean,
                descending=false: boolean,
                action: Action
              } */
              
          /** Action:function(key:string|number) -> undefined|string
              
              `Cursor` is a function called for each array or object encountered in the requested json structure. It is
              called with a `path` array (of strings and/or numeric indices) relative to the requested path (i.e. `[]`
              represents the path as requested in `get`) and an `array` boolean that is true if the substructure is an
              array. It returns an `Action` callback or object with a range and `action`, or false to prevent
              recursion into the structure. `lowerBound` and `upperBound` restrict the keys/indices traversed for this
              object/array, and the `Action` function is called with each `key` in the requested range, in order. The
              `Action` callback can optionally return either `'skip'` or `'stop'` to exclude the element at the given
              key from the structure or to exclude and stop iterating, respectively.
              
              For example, the following call uses a cursor to fetch only the immediate members of the object at the
              requested path. Object and array values will be empty:
              
             `db.get('path/to/object', false, function(path) {
                return !path.length;
              });`
              
              The following call will get immediate members of the requested object sorted lexicographically (by code
              unit value) up to and including key value `'c'`, but excluding key `'abc'` (if any):

             `db.get('path/to/object', false, function(path) {
                return path.length ? false : {
                  upperBound: 'c',
                  action: function(key) {
                    if (key == 'abc') return 'skip';
                  }
                };
              });` */
          return self = Array.isArray(stores) ? {
            get: function(store, path, cursor) {
              trans.get(store, path, cursor);
              return self;
            },
            put: !writable ? null : function(store, path, value) {
              trans.put(store, path, value);
              return self;
            },
            insert: !writable ? null : function(store, path, value) {
              trans.put(store, path, value, true);
              return self;
            },
            append: !writable ? null : function(store, path, value) {
              trans.append(store, path, value);
              return self;
            },
            delete: !writable ? null : function(store, store, path) {
              trans.delete(store, store, path);
              return self;
            },
            then: function(callback) {
              cb = callback;
            }
          } : {
            get: function(path, cursor) {
              trans.get(stores, path, cursor);
              return self;
            },
            put: !writable ? null : function(path, value) {
              trans.put(stores, path, value);
              return self;
            },
            insert: !writable ? null : function(path, value) {
              trans.put(stores, path, value, true);
              return self;
            },
            append: !writable ? null : function(path, value) {
              trans.append(stores, path, value);
              return self;
            },
            delete: !writable ? null : function(path) {
              trans.delete(stores, path);
              return self;
            },
            then: function(callback) {
              cb = callback;
            }
          };
        },
        get: function(path, writable, cursor, store) {
          return self.transaction(writable, store).get(path, cursor);
        },
        put: function(path, value, store) {
          return self.transaction(true, store).put(path, value);
        },
        insert: function(path, value, store) {
          return self.transaction(true, store).insert(path, value);
        },
        append: function(path, value, store) {
          return self.transaction(true, store).append(path, value);
        },
        delete: function(path, store) {
          return self.transaction(true, store).delete(path);
        },
        close: function() {
          if (db) {
            db.close();
            db = null;
          } else {
            close = true;
          }
        }
      };
    },
    delete: function(database, callback) {
      var request = indexedDB.deleteDatabase(database);
      request.onsuccess = request.onerror = function(e) {
        callback(e.target.error, false);
      };
      request.onblocked = function() {
        callback(null, true);
      };
    },
    list: function(callback) {
      indexedDB.webkitGetDatabaseNames().onsuccess = function(e) {
        callback(e.target.result);
      };
    }
  };
}();
