/** SIMPLE, ROBUST DRIVE TO GOOGLE PHOTOS UPLOADER (ES5 syntax) **/

/* ===== CONFIG ===== */
var BATCH_SIZE = 200; // how many images to upload per run
var ALBUM_NAME = 'From Google Drive';
var LOG_SPREADSHEET_NAME = 'Drive to Photos Upload Log'; // spreadsheet title
var LOG_SHEET_NAME = 'Log';
var HEADERS = ['fileId', 'name', 'mimeType', 'uploadedAt', 'mediaItemId'];
var PHOTOS_BATCH_LIMIT = 50; // Google Photos batchCreate limit
var UPLOAD_QUEUE_SIZE = 8; // how many upload requests to pipeline at once
var EXCLUDED_EXTENSIONS = ['.sis', '.sil', '.sim', '.bmp'];
var MAX_IMAGE_BYTES = 200 * 1024 * 1024; // Photos still-image upload cap

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
  var uploadQueue = [];
  var stop = false;

  function processDrainedUploads_(drained) {
    for (var j = 0; j < drained.length; j++) {
      var record = drained[j];
      var entry = record.entry;
      if (!record.token) {
        Logger.log('Upload failed for Drive file ' + entry.fileId + ' (' + entry.name + '), will retry on next run.');
        Utilities.sleep(500);
        continue;
      }
      batchItems.push({
        description: 'From Drive: ' + entry.name,
        simpleMediaItem: { uploadToken: record.token }
      });
      pendingLogs.push([entry.fileId, entry.name, entry.mime, entry.loggedAt, null]);
    }
  }

  function maybeFlushUploadQueue_(force) {
    if (!uploadQueue.length) return;
    if (!force && uploadQueue.length < UPLOAD_QUEUE_SIZE) return;
    var drained = drainUploadQueue_(uploadQueue);
    processDrainedUploads_(drained);
  }

  while (!stop && uploaded < BATCH_SIZE) {
    var requestToken = pageToken || null;
    var resp = Drive.Files.list({
      q: "mimeType contains 'image/' and trashed = false and mimeType != 'image/bmp'",
      orderBy: 'modifiedDate asc, title asc',
      maxResults: fetchLimit,
      pageToken: requestToken,
      fields: 'nextPageToken,items(id,title,originalFilename,mimeType,fileSize)'
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

      var name = meta.title || meta.originalFilename || fileId;
      if (shouldSkipBySize_(meta.fileSize)) {
        Logger.log('Skipping Drive file ' + fileId + ' (' + name + ') due to size > ' + MAX_IMAGE_BYTES + ' bytes.');
        offset = i + 1;
        continue;
      }
      if (shouldExcludeFile_(name, mime)) {
        Logger.log('Skipping Drive file ' + fileId + ' (' + name + ') due to excluded type.');
        offset = i + 1;
        continue;
      }

      seen++;

      var blob = DriveApp.getFileById(fileId).getBlob();
      uploadQueue.push({
        fileId: fileId,
        name: name,
        mime: mime,
        blob: blob,
        loggedAt: new Date()
      });
      maybeFlushUploadQueue_(false);

      if (uploaded + pendingLogs.length + uploadQueue.length >= BATCH_SIZE ||
          batchItems.length + uploadQueue.length >= PHOTOS_BATCH_LIMIT) {
        maybeFlushUploadQueue_(true);
      }

      if (batchItems.length >= PHOTOS_BATCH_LIMIT ||
          (uploaded + pendingLogs.length) >= BATCH_SIZE) {
        var ids = createMediaItemsBatch_(batchItems, albumId);
        if (ids === null) throw new Error('Failed to create Google Photos media items.');
        var newlyUploaded = logBatchResults_(sheet, pendingLogs, ids, uploadedMap);
        uploaded += newlyUploaded;
        Logger.log('Uploaded batch: ' + newlyUploaded + ' (total this run: ' + uploaded + ')');
        batchItems = [];
        pendingLogs = [];
      }

      offset = i + 1;

      if (uploaded >= BATCH_SIZE) {
        maybeFlushUploadQueue_(true);
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

  maybeFlushUploadQueue_(true);
  if (batchItems.length) {
    var remainingIds = createMediaItemsBatch_(batchItems, albumId);
    if (remainingIds === null) throw new Error('Failed to create Google Photos media items.');
    var finalUploaded = logBatchResults_(sheet, pendingLogs, remainingIds, uploadedMap);
    uploaded += finalUploaded;
    Logger.log('Uploaded final batch: ' + finalUploaded + ' (total this run: ' + uploaded + ')');
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
  if (!resp) return null;
  return resp.getContentText();
}

function createMediaItemsBatch_(items, albumId) {
  if (!items.length) return [];

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

  var json = {};
  try { json = JSON.parse(resp.getContentText() || '{}'); } catch (e) {}
  var results = json.newMediaItemResults || [];
  var ids = [];
  for (var i = 0; i < items.length; i++) {
    var res = results[i] || {};
    if (res.mediaItem && res.mediaItem.id) {
      ids.push(res.mediaItem.id);
    } else {
      ids.push(null);
    }
  }
  return ids;
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
  for (var i = 0; i < pendingLogs.length; i++) {
    var mediaItemId = ids[i] || null;
    if (!mediaItemId) continue;
    var row = pendingLogs[i];
    row[4] = mediaItemId;
    rows.push(row);
    if (uploadedMap) uploadedMap[row[0]] = true;
    successes++;
  }
  if (rows.length) {
    sheet.getRange(sheet.getLastRow() + 1, 1, rows.length, HEADERS.length).setValues(rows);
  }
  return successes;
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
  var index = Number(props.getProperty('DRIVE_CURSOR_INDEX'));
  if (isNaN(index)) index = 0;
  return {
    pageToken: token || '',
    index: index
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
  props.setProperty('DRIVE_CURSOR_INDEX', String(index || 0));
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
      } else {
        token = uploadToPhotos_(entry.blob, entry.name);
      }
      tokens.push(token);
      entry.blob = null;
    }
  }
  return tokens;
}
