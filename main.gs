/** SIMPLE, ROBUST DRIVE TO GOOGLE PHOTOS UPLOADER (ES5 syntax) **/

/* ===== CONFIG ===== */
var BATCH_SIZE = 200; // how many images to upload per run
var ALBUM_NAME = 'From Google Drive';
var LOG_SPREADSHEET_NAME = 'Drive to Photos Upload Log'; // spreadsheet title
var LOG_SHEET_NAME = 'Log';
var HEADERS = ['fileId', 'name', 'mimeType', 'uploadedAt', 'mediaItemId'];
var PHOTOS_BATCH_LIMIT = 50; // Google Photos batchCreate limit

/* ===== ENTRYPOINT ===== */
// Requires enabling the Advanced Drive Service (Drive API v2) for this project.
function runDriveToPhotosSync() {
  var sheet = getLogSheet_();
  ensureHeaders_(sheet);

  var uploadedMap = buildUploadedMap_(sheet);

  var albumId = getCachedAlbumId_();
  if (!albumId) {
    albumId = getOrCreateAlbum_(ALBUM_NAME);
    if (!albumId) throw new Error('Could not create or fetch album: ' + ALBUM_NAME);
    cacheAlbumId_(albumId);
  }

  var cursor = getDriveCursor_();
  var pageToken = cursor.pageToken;
  var offset = cursor.index;

  var uploaded = 0;
  var seen = 0;
  var fetchLimit = Math.min(BATCH_SIZE, 100); // Drive API maxResults cap
  var batchItems = [];
  var pendingLogs = [];
  var pendingCursorRefs = [];
  var stop = false;

  while (!stop && uploaded < BATCH_SIZE) {
    var requestToken = pageToken || null;
    var resp = Drive.Files.list({
      q: "mimeType contains 'image/' and trashed = false",
      orderBy: 'modifiedDate asc, title asc',
      maxResults: fetchLimit,
      pageToken: requestToken
    });

    var files = resp.items || [];
    if (!files.length) {
      pageToken = resp.nextPageToken || '';
      offset = 0;
      if (!pageToken) stop = true;
      continue;
    }

    for (var i = offset; i < files.length; i++) {
      var meta = files[i];
      var fileId = meta.id;
      if (uploadedMap[fileId]) {
        offset = i + 1;
        continue;
      }

      var mime = meta.mimeType || '';
      if (!mime || mime.indexOf('image/') !== 0) {
        offset = i + 1;
        continue;
      }

      seen++;

      var name = meta.title || meta.originalFilename || fileId;
      var blob = DriveApp.getFileById(fileId).getBlob();
      var upload = uploadToPhotos_(blob, name);
      if (!upload.token) {
        Logger.log('Upload failed for "' + name + '": ' + (upload.error || 'Unknown error'));
        pageToken = requestToken || '';
        offset = i;
        stop = true;
        break;
      }

      batchItems.push({
        description: 'From Drive: ' + name,
        simpleMediaItem: { uploadToken: upload.token }
      });
      pendingLogs.push([fileId, name, mime, new Date(), null]);
      pendingCursorRefs.push({ pageToken: requestToken || '', index: i });

      offset = i + 1;

      if (batchItems.length === PHOTOS_BATCH_LIMIT || uploaded + pendingLogs.length >= BATCH_SIZE) {
        var batchResult = createMediaItemsBatch_(batchItems, albumId);
        if (batchResult === null) throw new Error('Failed to create Google Photos media items.');
        var logResult = logBatchResults_(sheet, pendingLogs, batchResult.ids, uploadedMap);
        uploaded += logResult.successes;
        if (logResult.failedIndexes.length) {
          var failureIndex = logResult.failedIndexes[0];
          var cursorRef = pendingCursorRefs[failureIndex];
          var failureMessage = getBatchErrorMessage_(batchResult.errors, failureIndex);
          Logger.log('Stopping after batchCreate error for "' + pendingLogs[failureIndex][1] + '": ' + failureMessage);
          pageToken = cursorRef ? cursorRef.pageToken : requestToken || '';
          offset = cursorRef ? cursorRef.index : i;
          stop = true;
        }
        batchItems = [];
        pendingLogs = [];
        pendingCursorRefs = [];
        if (stop) break;
      }

      if (uploaded >= BATCH_SIZE) {
        offset = i + 1;
        pageToken = requestToken || '';
        stop = true;
        break;
      }
    }

    if (stop || uploaded >= BATCH_SIZE) break;

    pageToken = resp.nextPageToken || '';
    offset = 0;
    if (!pageToken) {
      stop = true;
    }
  }

  if (batchItems.length) {
    var remainingResult = createMediaItemsBatch_(batchItems, albumId);
    if (remainingResult === null) throw new Error('Failed to create Google Photos media items.');
    var remainingLog = logBatchResults_(sheet, pendingLogs, remainingResult.ids, uploadedMap);
    uploaded += remainingLog.successes;
    if (remainingLog.failedIndexes.length) {
      var remainingIndex = remainingLog.failedIndexes[0];
      var remainingCursor = pendingCursorRefs[remainingIndex];
      var remainingMessage = getBatchErrorMessage_(remainingResult.errors, remainingIndex);
      Logger.log('Stopping after final batchCreate error for "' + pendingLogs[remainingIndex][1] + '": ' + remainingMessage);
      pageToken = remainingCursor ? remainingCursor.pageToken : pageToken;
      offset = remainingCursor ? remainingCursor.index : offset;
    }
    pendingLogs = [];
    pendingCursorRefs = [];
  }

  saveDriveCursor_(pageToken, offset);
  Logger.log('Processed: ' + seen + ', Uploaded: ' + uploaded + ' (this run).');
}

/* ===== GOOGLE PHOTOS API HELPERS ===== */

function uploadToPhotos_(blob, fileName) {
  var resp = fetchWithRetry_(function () {
    return UrlFetchApp.fetch('https://photoslibrary.googleapis.com/v1/uploads', {
      method: 'post',
      muteHttpExceptions: true,
      headers: {
        'Authorization': 'Bearer ' + ScriptApp.getOAuthToken(),
        'Content-Type': 'application/octet-stream',
        'X-Goog-Upload-File-Name': fileName,
        'X-Goog-Upload-Protocol': 'raw'
      },
      payload: blob.getBytes()
    });
  }, 5, 1000, function (r) {
    var c = r.getResponseCode();
    return c >= 200 && c < 300;
  });

  if (!resp) {
    return { token: null, error: 'No response from upload endpoint after retries.' };
  }

  if (!resp.getResponseCode) {
    return { token: null, error: 'Upload failed: missing response code.' };
  }

  var code = resp.getResponseCode();
  var body = resp.getContentText ? resp.getContentText() : '';

  if (code < 200 || code >= 300) {
    var message = 'HTTP ' + code;
    if (body) message += ' - ' + truncateString_(body, 200);
    return { token: null, error: message };
  }

  if (!body) {
    return { token: null, error: 'Upload endpoint returned empty body.' };
  }

  return { token: body, error: null };
}

function createMediaItemsBatch_(items, albumId) {
  if (!items.length) return { ids: [], errors: [] };

  var body = {
    newMediaItems: items
  };
  if (albumId) body.albumId = albumId;

  var resp = fetchWithRetry_(function () {
    return UrlFetchApp.fetch('https://photoslibrary.googleapis.com/v1/mediaItems:batchCreate', {
      method: 'post',
      muteHttpExceptions: true,
      headers: {
        'Authorization': 'Bearer ' + ScriptApp.getOAuthToken(),
        'Content-Type': 'application/json'
      },
      payload: JSON.stringify(body)
    });
  }, 5, 1000, function (r) {
    var c = r.getResponseCode();
    return c >= 200 && c < 300;
  });

  if (!resp) return null;

  if (!resp.getResponseCode || resp.getResponseCode() < 200 || resp.getResponseCode() >= 300) {
    return null;
  }

  var json = {};
  try { json = JSON.parse(resp.getContentText() || '{}'); } catch (e) {}
  if (json.error) {
    var batchErrorMessage = json.error.message || 'Unknown batch error';
    var batchErrorCode = json.error.code || null;
    var batchErrors = [];
    for (var e = 0; e < items.length; e++) {
      batchErrors[e] = { code: batchErrorCode, message: batchErrorMessage, status: json.error };
    }
    return { ids: [], errors: batchErrors };
  }

  var results = json.newMediaItemResults || [];
  var ids = [];
  var errors = [];

  for (var i = 0; i < items.length; i++) {
    var res = results[i] || {};
    if (res.mediaItem && res.mediaItem.id) {
      ids.push(res.mediaItem.id);
      errors[i] = null;
      continue;
    }

    var status = res.status || {};
    var message = status.message || 'Unknown error';
    ids.push(null);
    errors[i] = {
      code: status.code || null,
      message: message,
      status: status
    };
  }

  if (results.length < items.length) {
    for (var j = results.length; j < items.length; j++) {
      if (typeof errors[j] === 'undefined') {
        ids[j] = null;
        errors[j] = { code: null, message: 'No result returned for media item.', status: {} };
      }
    }
  }

  return { ids: ids, errors: errors };
}

function listAlbums_() {
  var albums = [];
  var pageToken = null;
  do {
    var url = 'https://photoslibrary.googleapis.com/v1/albums';
    if (pageToken) url += '?pageToken=' + encodeURIComponent(pageToken);
    var resp = UrlFetchApp.fetch(url, {
      method: 'get',
      muteHttpExceptions: true,
      headers: { 'Authorization': 'Bearer ' + ScriptApp.getOAuthToken() }
    });
    if (resp.getResponseCode() !== 200) break;
    var json = {};
    try { json = JSON.parse(resp.getContentText() || '{}'); } catch (e) {}
    var arr = json.albums || [];
    for (var i = 0; i < arr.length; i++) albums.push(arr[i]);
    pageToken = json.nextPageToken || null;
  } while (pageToken);
  return albums;
}

function getOrCreateAlbum_(name) {
  var albums = listAlbums_();
  for (var i = 0; i < albums.length; i++) {
    if (albums[i].title === name) return albums[i].id;
  }
  var resp = UrlFetchApp.fetch('https://photoslibrary.googleapis.com/v1/albums', {
    method: 'post',
    muteHttpExceptions: true,
    headers: {
      'Authorization': 'Bearer ' + ScriptApp.getOAuthToken(),
      'Content-Type': 'application/json'
    },
    payload: JSON.stringify({ album: { title: name } })
  });
  if (resp.getResponseCode() >= 200 && resp.getResponseCode() < 300) {
    var json = {};
    try { json = JSON.parse(resp.getContentText() || '{}'); } catch (e) {}
    return json.id || null;
  }
  return null;
}

/* ===== LOGGING SUPPORT ===== */

function getLogSheet_() {
  var props = PropertiesService.getScriptProperties();
  var ssId = props.getProperty('LOG_SHEET_ID');
  var ss;

  if (ssId) {
    ss = SpreadsheetApp.openById(ssId);
  } else {
    // Try to reuse by name first
    var files = DriveApp.getFilesByName(LOG_SPREADSHEET_NAME);
    if (files.hasNext()) {
      var file = files.next();
      ss = SpreadsheetApp.open(file);
    } else {
      ss = SpreadsheetApp.create(LOG_SPREADSHEET_NAME);
    }
    props.setProperty('LOG_SHEET_ID', ss.getId());
  }

  var sheet = ss.getSheetByName(LOG_SHEET_NAME);
  if (!sheet) sheet = ss.insertSheet(LOG_SHEET_NAME);
  return sheet;
}

function ensureHeaders_(sheet) {
  var lastRow = sheet.getLastRow();
  if (lastRow === 0) {
    sheet.appendRow(HEADERS);
    return;
  }
  var existing = sheet.getRange(1, 1, 1, HEADERS.length).getValues()[0];
  var ok = true;
  for (var i = 0; i < HEADERS.length; i++) {
    if ((existing[i] || '') !== HEADERS[i]) { ok = false; break; }
  }
  if (!ok) {
    sheet.getRange(1, 1, 1, HEADERS.length).setValues([HEADERS]);
  }
}

function logBatchResults_(sheet, pendingLogs, ids, uploadedMap) {
  var rows = [];
  var successes = 0;
  var failedIndexes = [];
  ids = ids || [];
  for (var i = 0; i < pendingLogs.length; i++) {
    var mediaItemId = ids[i] || null;
    if (!mediaItemId) {
      failedIndexes.push(i);
      continue;
    }
    var row = pendingLogs[i];
    row[4] = mediaItemId;
    rows.push(row);
    if (uploadedMap) uploadedMap[row[0]] = true;
    successes++;
  }
  if (rows.length) {
    sheet.getRange(sheet.getLastRow() + 1, 1, rows.length, HEADERS.length).setValues(rows);
  }
  return { successes: successes, failedIndexes: failedIndexes };
}

function buildUploadedMap_(sheet) {
  var lastRow = sheet.getLastRow();
  var map = {};
  if (lastRow < 2) return map;
  var values = sheet.getRange(2, 1, lastRow - 1, 1).getValues();
  for (var i = 0; i < values.length; i++) {
    var id = values[i][0];
    if (id) map[id] = true;
  }
  return map;
}

function getDriveCursor_() {
  var props = PropertiesService.getScriptProperties();
  var token = props.getProperty('DRIVE_CURSOR_TOKEN');
  var index = props.getProperty('DRIVE_CURSOR_INDEX');
  return {
    pageToken: token || '',
    index: index ? Number(index) : 0
  };
}

function saveDriveCursor_(pageToken, index) {
  var props = PropertiesService.getScriptProperties();
  if (!pageToken && !index) {
    props.deleteProperty('DRIVE_CURSOR_TOKEN');
    props.deleteProperty('DRIVE_CURSOR_INDEX');
    return;
  }
  props.setProperty('DRIVE_CURSOR_TOKEN', pageToken || '');
  props.setProperty('DRIVE_CURSOR_INDEX', index || 0);
}

/* ===== CACHE HELPERS ===== */
function getCachedAlbumId_() {
  return PropertiesService.getScriptProperties().getProperty('ALBUM_ID');
}
function cacheAlbumId_(id) {
  PropertiesService.getScriptProperties().setProperty('ALBUM_ID', id);
}

/* ===== RETRY WITH BACKOFF ===== */

function fetchWithRetry_(fn, maxAttempts, baseDelayMs, successPredicate) {
  var attempt = 0;
  var last = null;
  while (attempt < maxAttempts) {
    try {
      var resp = fn();
      last = resp;
      if (successPredicate(resp)) return resp;
      var code = resp.getResponseCode();
      if (code === 429 || (code >= 500 && code < 600)) {
        Utilities.sleep(baseDelayMs * Math.pow(2, attempt));
      } else {
        return resp; // non-retryable status
      }
    } catch (e) {
      Utilities.sleep(baseDelayMs * Math.pow(2, attempt));
    }
    attempt++;
  }
  return last;
}

function truncateString_(value, maxLength) {
  if (!value) return '';
  if (value.length <= maxLength) return value;
  return value.substring(0, maxLength) + '...';
}

function getBatchErrorMessage_(errors, index) {
  if (!errors || typeof index !== 'number' || index < 0 || index >= errors.length) {
    return 'Unknown error';
  }
  var entry = errors[index];
  if (!entry) return 'Unknown error';
  if (entry.message) return entry.message;
  if (entry.status && entry.status.message) return entry.status.message;
  return 'Unknown error';
}

function shouldExcludeFile_(name, mime) {
  if (mime === 'image/bmp') return true;
  var lower = (name || '').toLowerCase();
  for (var i = 0; i < EXCLUDED_EXTENSIONS.length; i++) {
    var ext = EXCLUDED_EXTENSIONS[i];
    if (lower.length >= ext.length && lower.lastIndexOf(ext) === lower.length - ext.length) {
      return true;
    }
  }
  return false;
}

function drainUploadQueue_(queue) {
  if (!queue || !queue.length) return [];
  var drained = queue.splice(0, queue.length);
  var tokens = uploadBlobsWithConcurrency_(drained);
  var results = [];
  for (var i = 0; i < drained.length; i++) {
    results.push({ entry: drained[i], token: tokens[i] || null });
  }
  return results;
}

function shouldSkipBySize_(sizeValue) {
  if (!sizeValue) return false;
  var bytes = Number(sizeValue);
  if (isNaN(bytes)) return false;
  return bytes > MAX_IMAGE_BYTES;
}

function uploadBlobsWithConcurrency_(entries) {
  if (!entries.length) return [];
  var tokens = [];
  var authToken = ScriptApp.getOAuthToken();
  for (var i = 0; i < entries.length; i += UPLOAD_QUEUE_SIZE) {
    var chunk = entries.slice(i, i + UPLOAD_QUEUE_SIZE);
    var requests = [];
    for (var j = 0; j < chunk.length; j++) {
      requests.push({
        url: 'https://photoslibrary.googleapis.com/v1/uploads',
        method: 'post',
        muteHttpExceptions: true,
        headers: {
          'Authorization': 'Bearer ' + authToken,
          'Content-Type': 'application/octet-stream',
          'X-Goog-Upload-File-Name': chunk[j].name,
          'X-Goog-Upload-Protocol': 'raw'
        },
        payload: chunk[j].blob.getBytes()
      });
    }

    var responses = [];
    try {
      responses = UrlFetchApp.fetchAll(requests);
    } catch (e) {
      responses = [];
    }

    for (var k = 0; k < chunk.length; k++) {
      var entry = chunk[k];
      var resp = responses[k];
      var token = null;
      if (resp && resp.getResponseCode && resp.getResponseCode() >= 200 && resp.getResponseCode() < 300) {
        token = resp.getContentText();
        if (!token) {
          var fallbackEmpty = uploadToPhotos_(entry.blob, entry.name);
          if (!fallbackEmpty.token) {
            Logger.log('Upload retry failed for "' + entry.name + '": ' + (fallbackEmpty.error || 'Unknown error'));
          }
          token = fallbackEmpty.token;
        }
      } else {
        var retry = uploadToPhotos_(entry.blob, entry.name);
        if (!retry.token) {
          Logger.log('Upload retry failed for "' + entry.name + '": ' + (retry.error || 'Unknown error'));
        }
        token = retry.token;
      }
      tokens.push(token || null);
      entry.blob = null;
    }
  }
  return tokens;
}
