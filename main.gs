/**
 * SIMPLE, ROBUST DRIVE TO GOOGLE PHOTOS UPLOADER (ES5 syntax).
 *
 * The script is designed to run inside Google Apps Script.  It scans Google Drive
 * for supported image files and uploads them to Google Photos, keeping track of
 * progress in a spreadsheet so reruns only handle new work.
 */

/* ===== CONFIG ===== */
// Global configuration values for the sync run.  Adjust the options below to
// fit your Drive folder structure and upload cadence.
var BATCH_SIZE = 200; // how many images to upload per run
var ALBUM_NAME = 'From Google Drive';
var LOG_SPREADSHEET_NAME = 'Drive to Photos Upload Log'; // spreadsheet title
var LOG_SHEET_NAME = 'Log';
var HEADERS = ['fileId', 'name', 'mimeType', 'uploadedAt', 'mediaItemId'];
var PHOTOS_BATCH_LIMIT = 50; // Google Photos batchCreate limit
var PROGRESS_LOG_INTERVAL = 10; // how often to log progress while scanning Drive
var MAX_UPLOAD_RUN_FAILURES = 3; // retry runs before treating an item as failed
var MAX_RUNTIME_MS = 4.5 * 60 * 1000; // exit early with buffer so time-driven triggers can restart
/** MIME types that are eligible for upload to Google Photos. */
var SUPPORTED_MIME_TYPES = [
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/heic',
  'image/heif',
  'image/avif'
];
/** Fast lookup table built from the allowlist above. */
var SUPPORTED_MIME_TYPE_LOOKUP = (function () {
  var lookup = {};
  for (var i = 0; i < SUPPORTED_MIME_TYPES.length; i++) {
    lookup[SUPPORTED_MIME_TYPES[i].toLowerCase()] = true;
  }
  return lookup;
})();

/* ===== ENTRYPOINT ===== */
/**
 * Main entry point for the sync job.
 *
 * Requires enabling the Advanced Drive Service (Drive API v2) and the Google
 * Photos Library API.  Each invocation resumes from the persisted Drive cursor
 * and uploads images to the configured album until BATCH_SIZE items have been
 * processed or a retryable error occurs.
 */
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
  var resumeFileId = cursor.fileId || '';
  var resumeRealignAttempted = false;
  var uploadFailureState = loadUploadFailureState_();
  var loadedFailureKeys = uploadFailureState && uploadFailureState.counts ? Object.keys(uploadFailureState.counts) : [];
  Logger.log('Loaded ' + loadedFailureKeys.length + ' upload failure record(s) from previous runs.');

  var uploaded = 0;
  var seen = 0;
  var fetchLimit = Math.min(BATCH_SIZE, 100); // Drive API maxResults cap
  var batchItems = [];
  var pendingLogs = [];
  var pendingCursorRefs = [];
  var stop = false;
  var skippedAlreadyLogged = 0;
  var skippedUnsupportedMime = 0;
  var processed = 0;
  var lastProgressLogCount = 0;
  var startTimeMs = new Date().getTime();
  var lastPersistedToken = pageToken || '';
  var lastPersistedIndex = offset || 0;
  var lastPersistedFileId = resumeFileId;
  var nextCursorFileId = resumeFileId;

  /** Safely persists the cursor only when there is no in-flight upload work. */
  function maybePersistCursor(currentToken, currentIndex, currentFileId) {
    if (batchItems.length || pendingLogs.length) return;
    var normalizedToken = currentToken || '';
    var normalizedIndex = currentIndex || 0;
    var normalizedFileId = currentFileId || '';
    if (normalizedToken === lastPersistedToken &&
        normalizedIndex === lastPersistedIndex &&
        normalizedFileId === lastPersistedFileId) {
      return;
    }
    saveDriveCursor_(normalizedToken, normalizedIndex, normalizedFileId);
    lastPersistedToken = normalizedToken;
    lastPersistedIndex = normalizedIndex;
    lastPersistedFileId = normalizedFileId;
  }

  Logger.log('Starting sync. Existing cursor: pageToken=' + (pageToken ? 'set' : 'unset') + ', index=' + offset + '.');

  /** Logs periodic progress updates so long runs surface activity. */
  function logProgressIfNeeded() {
    if (processed === 0) return;
    if (processed === 1 || processed - lastProgressLogCount >= PROGRESS_LOG_INTERVAL) {
      Logger.log('Progress: Processed ' + processed + ' item(s) this run (Uploaded: ' + uploaded + ', Pending: ' + pendingLogs.length + ', Skipped existing: ' + skippedAlreadyLogged + ', Skipped unsupported: ' + skippedUnsupportedMime + ').');
      lastProgressLogCount = processed;
    }
  }

  while (!stop && uploaded < BATCH_SIZE) {
    if (new Date().getTime() - startTimeMs >= MAX_RUNTIME_MS) {
      Logger.log('Stopping early to avoid Apps Script execution timeout. Progress saved.');
      stop = true;
      break;
    }

    var requestToken = pageToken || null;
    Logger.log('Listing Drive files (requestToken=' + (pageToken ? 'set' : 'unset') + ', offset=' + offset + ', fetchLimit=' + fetchLimit + ').');
    var resp = Drive.Files.list({
      q: getDriveMimeFilterQuery_(),
      orderBy: 'modifiedDate asc, title asc',
      maxResults: fetchLimit,
      pageToken: requestToken
    });

    var files = resp.items || [];
    Logger.log('Fetched ' + files.length + ' item(s) from Drive (requestToken=' + (requestToken ? 'set' : 'unset') + ', nextPageToken=' + (resp.nextPageToken ? 'set' : 'unset') + ').');
    var hadResumeFileId = !!resumeFileId;
    if (resumeFileId) {
      var resumeIndex = -1;
      for (var ri = 0; ri < files.length; ri++) {
        if (files[ri].id === resumeFileId) {
          resumeIndex = ri;
          break;
        }
      }

      if (resumeIndex === -1) {
        if (requestToken && !resumeRealignAttempted) {
          Logger.log('Drive cursor misaligned for fileId ' + resumeFileId + '. Restarting from beginning (requestToken was set).');
          resumeRealignAttempted = true;
          pageToken = '';
          offset = 0;
          continue;
        }

        if (resp.nextPageToken) {
          Logger.log('Resume file ' + resumeFileId + ' not on current page. Advancing to next pageToken.');
          pageToken = resp.nextPageToken;
          offset = 0;
          continue;
        }

        Logger.log('Drive cursor target ' + resumeFileId + ' no longer found anywhere. Resetting cursor to start.');
        resumeFileId = '';
        pageToken = '';
        offset = 0;
      } else {
        Logger.log('Realigned cursor to resume file ' + resumeFileId + ' at index ' + resumeIndex + ' within current page.');
        offset = resumeIndex;
        resumeFileId = '';
      }
    }
    if (!hadResumeFileId && offset > 0) {
      Logger.log('Resetting offset to 0 because resumeFileId was not set but offset remained at ' + offset + '.');
      offset = 0;
    }
    if (!files.length) {
      pageToken = resp.nextPageToken || '';
      offset = 0;
      if (!pageToken) {
        nextCursorFileId = '';
      }
      maybePersistCursor(pageToken, offset, nextCursorFileId);
      if (!pageToken) stop = true;
      continue;
    }

    for (var i = offset; i < files.length; i++) {
      var meta = files[i];
      processed++;
      var fileId = meta.id;
      if (uploadedMap[fileId]) {
        Logger.log('Skipping already logged file "' + (meta.title || meta.originalFilename || fileId) + '" (' + fileId + ').');
        offset = i + 1;
        skippedAlreadyLogged++;
        nextCursorFileId = (offset < files.length) ? files[offset].id : '';
        logProgressIfNeeded();
        maybePersistCursor(requestToken || '', offset, nextCursorFileId);
        continue;
      }

      var mime = meta.mimeType || '';
      if (!isSupportedMimeType_(mime)) {
        Logger.log('Skipping unsupported mime type for file "' + (meta.title || meta.originalFilename || fileId) + '" (' + fileId + '): ' + mime + '.');
        offset = i + 1;
        skippedUnsupportedMime++;
        nextCursorFileId = (offset < files.length) ? files[offset].id : '';
        logProgressIfNeeded();
        maybePersistCursor(requestToken || '', offset, nextCursorFileId);
        continue;
      }

      seen++;
      logProgressIfNeeded();

      var name = meta.title || meta.originalFilename || fileId;
      var preExistingFailures = uploadFailureState && uploadFailureState.counts ? uploadFailureState.counts[fileId] || 0 : 0;
      if (preExistingFailures > 0) {
        Logger.log('Retrying upload for "' + name + '" (' + fileId + ') with existing failure count ' + preExistingFailures + '.');
      } else {
        Logger.log('Preparing upload for "' + name + '" (' + fileId + ') with mime type ' + mime + '.');
      }
      var blob = DriveApp.getFileById(fileId).getBlob();
      var upload = uploadToPhotos_(blob, name);
      if (!upload.token) {
        var uploadErrorMessage = (upload.error && upload.error.message) ? upload.error.message : 'Unknown error';
        Logger.log('Upload failed for "' + name + '": ' + uploadErrorMessage);
        var shouldRetryUpload = !upload.error || upload.error.retryable !== false;
        if (shouldRetryUpload) {
          var failureCount = markUploadFailure_(uploadFailureState, fileId);
          persistUploadFailureState_(uploadFailureState);
          Logger.log('Upload failure count for "' + name + '" (' + fileId + '): ' + failureCount + '.');
          if (failureCount >= MAX_UPLOAD_RUN_FAILURES) {
            Logger.log('Giving up on "' + name + '" after ' + failureCount + ' failed upload attempt(s).');
            var finalMessage = uploadErrorMessage + ' (skipped after ' + failureCount + ' failed attempt(s))';
            logNonRetryableUploadFailure_(sheet, fileId, name, mime, finalMessage, uploadedMap);
            clearUploadFailure_(uploadFailureState, fileId);
            persistUploadFailureState_(uploadFailureState);
            offset = i + 1;
            nextCursorFileId = (offset < files.length) ? files[offset].id : '';
            logProgressIfNeeded();
            maybePersistCursor(requestToken || '', offset, nextCursorFileId);
            continue;
          }

          Logger.log('Encountered retryable upload failure for "' + name + '". Will resume from same Drive page on next run.');
          pageToken = requestToken || '';
          offset = i;
          nextCursorFileId = fileId;
          logProgressIfNeeded();
          stop = true;
          break;
        }

        logNonRetryableUploadFailure_(sheet, fileId, name, mime, uploadErrorMessage, uploadedMap);
        clearUploadFailure_(uploadFailureState, fileId);
        persistUploadFailureState_(uploadFailureState);
        Logger.log('Logged non-retryable upload failure for "' + name + '" (' + fileId + ').');
        offset = i + 1;
        nextCursorFileId = (offset < files.length) ? files[offset].id : '';
        logProgressIfNeeded();
        maybePersistCursor(requestToken || '', offset, nextCursorFileId);
        continue;
      }

      clearUploadFailure_(uploadFailureState, fileId);
      persistUploadFailureState_(uploadFailureState);
      Logger.log('Upload succeeded for "' + name + '" (' + fileId + '). Queuing for batch create.');

      batchItems.push({
        description: 'From Drive: ' + name,
        simpleMediaItem: { uploadToken: upload.token }
      });
      pendingLogs.push([fileId, name, mime, new Date(), null]);
      pendingCursorRefs.push({ pageToken: requestToken || '', index: i, fileId: fileId });

      offset = i + 1;
      nextCursorFileId = (offset < files.length) ? files[offset].id : '';
      maybePersistCursor(requestToken || '', offset, nextCursorFileId);

      if (batchItems.length === PHOTOS_BATCH_LIMIT || uploaded + pendingLogs.length >= BATCH_SIZE) {
        Logger.log('Committing batch of ' + batchItems.length + ' upload(s) to Google Photos.');
        var batchResult = createMediaItemsBatch_(batchItems, albumId);
        if (batchResult === null) throw new Error('Failed to create Google Photos media items.');
        var logResult = logBatchResults_(sheet, pendingLogs, batchResult, uploadedMap);
        uploaded += logResult.successes;

        if (logResult.successes > 0) {
          Logger.log('Batch uploaded ' + logResult.successes + ' item(s). Total uploaded this run: ' + uploaded + '.');
        } else if (!logResult.retryableIndexes.length && !logResult.skippedDetails.length) {
          Logger.log('Batch completed with no successful uploads. Total uploaded this run: ' + uploaded + '.');
        }

        for (var s = 0; s < logResult.skippedDetails.length; s++) {
          var skippedDetail = logResult.skippedDetails[s];
          Logger.log('Skipping item after non-retryable batchCreate error for "' + skippedDetail.name + '": ' + skippedDetail.message);
        }

        if (logResult.retryableIndexes.length) {
          var failureIndex = logResult.retryableIndexes[0];
          var cursorRef = pendingCursorRefs[failureIndex];
          var failureMessage = getBatchErrorMessage_(batchResult.errors, failureIndex);
          Logger.log('Stopping after batchCreate error for "' + pendingLogs[failureIndex][1] + '": ' + failureMessage);
          pageToken = cursorRef ? cursorRef.pageToken : requestToken || '';
          offset = cursorRef ? cursorRef.index : i;
          nextCursorFileId = cursorRef ? cursorRef.fileId || '' : '';
          stop = true;
        }
        batchItems = [];
        pendingLogs = [];
        pendingCursorRefs = [];
        maybePersistCursor(pageToken, offset, nextCursorFileId);
        if (stop) break;
      }

      if (new Date().getTime() - startTimeMs >= MAX_RUNTIME_MS) {
        Logger.log('Stopping early within page to avoid Apps Script timeout. Progress saved.');
        pageToken = requestToken || '';
        offset = i + 1;
        nextCursorFileId = (offset < files.length) ? files[offset].id : '';
        stop = true;
        break;
      }

      if (uploaded >= BATCH_SIZE) {
        offset = i + 1;
        pageToken = requestToken || '';
        nextCursorFileId = (offset < files.length) ? files[offset].id : '';
        stop = true;
        break;
      }
    }

    if (stop || uploaded >= BATCH_SIZE) break;

    pageToken = resp.nextPageToken || '';
    offset = 0;
    nextCursorFileId = '';
    maybePersistCursor(pageToken, offset, nextCursorFileId);
    if (!pageToken) {
      stop = true;
    }
  }

  if (batchItems.length) {
    Logger.log('Committing final batch of ' + batchItems.length + ' upload(s) to Google Photos.');
    var remainingResult = createMediaItemsBatch_(batchItems, albumId);
    if (remainingResult === null) throw new Error('Failed to create Google Photos media items.');
    var remainingLog = logBatchResults_(sheet, pendingLogs, remainingResult, uploadedMap);
    uploaded += remainingLog.successes;

    if (remainingLog.successes > 0) {
      Logger.log('Final batch uploaded ' + remainingLog.successes + ' item(s). Total uploaded this run: ' + uploaded + '.');
    } else if (!remainingLog.retryableIndexes.length && !remainingLog.skippedDetails.length) {
      Logger.log('Final batch completed with no successful uploads. Total uploaded this run: ' + uploaded + '.');
    }

    for (var rs = 0; rs < remainingLog.skippedDetails.length; rs++) {
      var skippedFinal = remainingLog.skippedDetails[rs];
      Logger.log('Skipping item after non-retryable batchCreate error for "' + skippedFinal.name + '": ' + skippedFinal.message);
    }

    if (remainingLog.retryableIndexes.length) {
      var remainingIndex = remainingLog.retryableIndexes[0];
      var remainingCursor = pendingCursorRefs[remainingIndex];
      var remainingMessage = getBatchErrorMessage_(remainingResult.errors, remainingIndex);
      Logger.log('Stopping after final batchCreate error for "' + pendingLogs[remainingIndex][1] + '": ' + remainingMessage);
      pageToken = remainingCursor ? remainingCursor.pageToken : pageToken;
      offset = remainingCursor ? remainingCursor.index : offset;
      nextCursorFileId = remainingCursor ? remainingCursor.fileId || '' : nextCursorFileId;
      stop = true;
    }
    pendingLogs = [];
    pendingCursorRefs = [];
    maybePersistCursor(pageToken, offset, nextCursorFileId);
  }

  persistUploadFailureState_(uploadFailureState);
  saveDriveCursor_(pageToken, offset, nextCursorFileId);
  Logger.log('Reviewed: ' + processed + ' Drive item(s). Attempted uploads: ' + seen + ', Uploaded: ' + uploaded + ' (this run). Skipped already logged: ' + skippedAlreadyLogged + ', Skipped unsupported mime: ' + skippedUnsupportedMime + '.');
}

/**
 * Builds the Drive API query that filters to supported image MIME types.
 *
 * @return {string} Query string that excludes trashed files and restricts to
 *     the SUPPORTED_MIME_TYPES allowlist.
 */
function getDriveMimeFilterQuery_() {
  var clauses = [];
  for (var i = 0; i < SUPPORTED_MIME_TYPES.length; i++) {
    clauses.push("mimeType = '" + SUPPORTED_MIME_TYPES[i] + "'");
  }
  if (!clauses.length) return "trashed = false";
  return "trashed = false and (" + clauses.join(' or ') + ")";
}

/* ===== GOOGLE PHOTOS API HELPERS ===== */

/**
 * Uploads a single blob to Google Photos and returns the upload token.
 *
 * @param {Blob} blob Drive file contents.
 * @param {string} fileName Original file name used for logging.
 * @return {{token: (string|null), error: (?Object)}} Upload result and error
 *     metadata.  Retryable failures are flagged via error.retryable.
 */
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
    return { token: null, error: { message: 'No response from upload endpoint after retries.', code: null, retryable: true } };
  }

  if (!resp.getResponseCode) {
    return { token: null, error: { message: 'Upload failed: missing response code.', code: null, retryable: true } };
  }

  var code = resp.getResponseCode();
  var body = resp.getContentText ? resp.getContentText() : '';

  if (code < 200 || code >= 300) {
    var message = 'HTTP ' + code;
    if (body) message += ' - ' + truncateString_(body, 200);
    return { token: null, error: { message: message, code: code, retryable: isRetryableStatusCode_(code) } };
  }

  if (!body) {
    return { token: null, error: { message: 'Upload endpoint returned empty body.', code: code, retryable: false } };
  }

  return { token: body, error: null };
}

/**
 * Calls the Google Photos batchCreate endpoint to finalize uploaded items.
 *
 * @param {!Array<!Object>} items Items created via upload tokens.
 * @param {string} albumId Target album ID or empty string for no album.
 * @return {{ids: !Array<(string|null)>, errors: !Array<(?Object)>}|null} Batch
 *     response or null when the API request failed outright.
 */
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

    var status = res.status || {};
    var message = status.message || 'Unknown error';
    ids.push(null);
    errors[i] = {
      code: status.code || null,
      message: message,
      status: status
    };
  }

  return { ids: ids, errors: errors };
}

/**
 * Checks whether the provided MIME type is allowlisted for upload.
 *
 * @param {string} mime MIME type from the Drive file metadata.
 * @return {boolean} True when the MIME type is supported.
 */
function isSupportedMimeType_(mime) {
  if (!mime) return false;
  var normalized = String(mime).toLowerCase();
  return !!SUPPORTED_MIME_TYPE_LOOKUP[normalized];
}

/**
 * Returns the list of Google Photos albums visible to the script.
 *
 * @return {!Array<!Object>} Album metadata objects.
 */
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

/**
 * Looks up (or creates) the Google Photos album used for imports.
 *
 * @param {string} name Album title to search for or create.
 * @return {(string|null)} Album ID when available.
 */
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

/**
 * Retrieves (or creates) the spreadsheet sheet used to track uploads.
 *
 * @return {!GoogleAppsScript.Spreadsheet.Sheet} Sheet handle.
 */
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

/**
 * Ensures the tracking sheet has the expected header row.
 *
 * @param {!GoogleAppsScript.Spreadsheet.Sheet} sheet Sheet to verify.
 */
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

/**
 * Writes batchCreate results to the log and determines retry handling.
 *
 * @param {!GoogleAppsScript.Spreadsheet.Sheet} sheet Destination sheet.
 * @param {!Array<!Array>} pendingLogs Rows prepared for logging.
 * @param {{ids: !Array, errors: !Array}} result Batch API response object.
 * @param {!Object} uploadedMap Mutable map of Drive IDs already handled.
 * @return {{successes: number, retryableIndexes: !Array<number>, skippedDetails: !Array<!Object>}}
 *     Breakdown of results used to control the sync loop.
 */
function logBatchResults_(sheet, pendingLogs, result, uploadedMap) {
  var ids = (result && result.ids) || [];
  var errors = (result && result.errors) || [];
  var successRows = [];
  var failureRows = [];
  var successes = 0;
  var retryableIndexes = [];
  var skippedDetails = [];

  for (var i = 0; i < pendingLogs.length; i++) {
    var entry = pendingLogs[i];
    var mediaItemId = ids[i] || null;
    if (mediaItemId) {
      entry[4] = mediaItemId;
      successRows.push(entry);
      if (uploadedMap) uploadedMap[entry[0]] = true;
      successes++;
      continue;
    }

    var error = errors[i] || null;
    if (isRetryableBatchError_(error)) {
      retryableIndexes.push(i);
      continue;
    }

    var failureRow = entry.slice();
    var failureMessage = getBatchErrorMessage_(errors, i);
    failureRow[4] = 'FAILED: ' + truncateString_(failureMessage, 200);
    failureRows.push(failureRow);
    skippedDetails.push({ index: i, name: entry[1], message: failureMessage });
    if (uploadedMap) uploadedMap[entry[0]] = true;
  }

  if (successRows.length) {
    sheet.getRange(sheet.getLastRow() + 1, 1, successRows.length, HEADERS.length).setValues(successRows);
  }
  if (failureRows.length) {
    sheet.getRange(sheet.getLastRow() + 1, 1, failureRows.length, HEADERS.length).setValues(failureRows);
  }

  return {
    successes: successes,
    retryableIndexes: retryableIndexes,
    skippedDetails: skippedDetails
  };
}

/**
 * Records a non-retryable upload failure in the log and marks the file as seen.
 */
function logNonRetryableUploadFailure_(sheet, fileId, name, mime, message, uploadedMap) {
  var row = [fileId, name, mime, new Date(), 'FAILED: ' + truncateString_(message, 200)];
  sheet.getRange(sheet.getLastRow() + 1, 1, 1, HEADERS.length).setValues([row]);
  if (uploadedMap) uploadedMap[fileId] = true;
}

/**
 * Builds a lookup of Drive IDs that have already been processed.
 *
 * @param {!GoogleAppsScript.Spreadsheet.Sheet} sheet Source sheet.
 * @return {!Object<string, boolean>} Map keyed by Drive file ID.
 */
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

/**
 * Returns the persisted Drive pagination state (page token + index).
 */
function getDriveCursor_() {
  var props = PropertiesService.getScriptProperties();
  var token = props.getProperty('DRIVE_CURSOR_TOKEN');
  var index = props.getProperty('DRIVE_CURSOR_INDEX');
  var fileId = props.getProperty('DRIVE_CURSOR_FILE_ID');
  return {
    pageToken: token || '',
    index: index ? Number(index) : 0,
    fileId: fileId || ''
  };
}

/**
 * Persists the Drive cursor state used to resume future runs.
 */
function saveDriveCursor_(pageToken, index, fileId) {
  var props = PropertiesService.getScriptProperties();
  var token = pageToken || '';
  var idx = (typeof index === 'number' && !isNaN(index)) ? index : Number(index) || 0;
  var nextId = fileId || '';
  if (!token && !idx && !nextId) {
    props.deleteProperty('DRIVE_CURSOR_TOKEN');
    props.deleteProperty('DRIVE_CURSOR_INDEX');
    props.deleteProperty('DRIVE_CURSOR_FILE_ID');
    return;
  }
  props.setProperty('DRIVE_CURSOR_TOKEN', token);
  props.setProperty('DRIVE_CURSOR_INDEX', String(idx || 0));
  if (nextId) {
    props.setProperty('DRIVE_CURSOR_FILE_ID', nextId);
  } else {
    props.deleteProperty('DRIVE_CURSOR_FILE_ID');
  }
}

/** Loads the persisted per-file upload failure counters. */
function loadUploadFailureState_() {
  var props = PropertiesService.getScriptProperties();
  var raw = props.getProperty('UPLOAD_FAILURE_COUNTS');
  if (!raw) return { counts: {}, dirty: false };
  try {
    var parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return { counts: {}, dirty: false };
    var counts = {};
    for (var key in parsed) {
      if (parsed.hasOwnProperty(key)) {
        var value = Number(parsed[key]);
        if (!isNaN(value) && value > 0) {
          counts[key] = Math.floor(value);
        }
      }
    }
    return { counts: counts, dirty: false };
  } catch (e) {
    return { counts: {}, dirty: false };
  }
}

/** Increments and returns the failure count for a file ID. */
function markUploadFailure_(state, fileId) {
  if (!state || !fileId) return 0;
  var counts = state.counts;
  var next = (counts[fileId] || 0) + 1;
  counts[fileId] = next;
  state.dirty = true;
  return next;
}

/** Clears any persisted upload failure count for a file ID. */
function clearUploadFailure_(state, fileId) {
  if (!state || !fileId) return;
  if (state.counts.hasOwnProperty(fileId)) {
    delete state.counts[fileId];
    state.dirty = true;
  }
}

/** Persists the upload failure counters if they have changed. */
function persistUploadFailureState_(state) {
  if (!state || !state.dirty) return;
  var props = PropertiesService.getScriptProperties();
  var keys = [];
  for (var key in state.counts) {
    if (state.counts.hasOwnProperty(key)) {
      keys.push(key);
    }
  }
  if (!keys.length) {
    props.deleteProperty('UPLOAD_FAILURE_COUNTS');
  } else {
    props.setProperty('UPLOAD_FAILURE_COUNTS', JSON.stringify(state.counts));
  }
  state.dirty = false;
}

/* ===== CACHE HELPERS ===== */
/** Retrieves the cached album ID if one has been stored. */
function getCachedAlbumId_() {
  return PropertiesService.getScriptProperties().getProperty('ALBUM_ID');
}
/** Stores the album ID for reuse across sync runs. */
function cacheAlbumId_(id) {
  PropertiesService.getScriptProperties().setProperty('ALBUM_ID', id);
}

/* ===== RETRY WITH BACKOFF ===== */

/**
 * Executes a request function with exponential backoff retry logic.
 */
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

/** Shortens long strings for logging. */
function truncateString_(value, maxLength) {
  if (!value) return '';
  if (value.length <= maxLength) return value;
  return value.substring(0, maxLength) + '...';
}

/** Determines if an HTTP status code is safe to retry. */
function isRetryableStatusCode_(code) {
  if (code === 429) return true;
  if (typeof code !== 'number') return false;
  return code >= 500 && code < 600;
}

/** Derives a human-readable error message for a batchCreate entry. */
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

/** Checks whether a batchCreate error warrants a retry. */
function isRetryableBatchError_(error) {
  if (!error) return true;
  var code = null;
  if (typeof error.code === 'number') code = error.code;
  if (code === null && error.status && typeof error.status.code === 'number') {
    code = error.status.code;
  }

  if (code === null && error.status && error.status.message) {
    var upper = String(error.status.message).toUpperCase();
    if (upper === 'RESOURCE_EXHAUSTED' || upper === 'UNAVAILABLE' || upper === 'ABORTED') {
      return true;
    }
  }

  if (code === null) return false;

  return code === 8 || code === 10 || code === 13 || code === 14;
}

