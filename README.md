# Google Drive to Google Photos Importer

This Apps Script scans Google Drive for supported image files and uploads them to Google Photos while keeping track of progress in a spreadsheet. Each run resumes from the last processed Drive item so the script can be scheduled as a time-based trigger without duplicating uploads.

## Prerequisites

* A Google account with access to Google Drive and Google Photos.
* Permission to create Google Cloud projects (required to enable the Google Photos Library API).
* The Google Apps Script project must use the **Drive API** advanced service and the **Google Photos Library API**.

## Set up the Apps Script project

1. Open [script.google.com](https://script.google.com) and create a **New project**.
2. Replace the default `Code.gs` contents with the script from [`main.gs`](main.gs). You can rename the file if desired.
3. Adjust the configuration constants at the top of the file (album name, batch size, etc.) to suit your workflow.

### Enable required services

1. In the Apps Script editor, open **Services** (the `+` icon next to "Services" in the left sidebar).
2. Search for **Drive API** and add it. This exposes `Drive.Files.list` used by the script.
3. Open **Project Settings → Google Cloud Platform (GCP) Project** and click **Change project** → **Create a project** (or **View API console** if one already exists). Note the project number.
4. In the Google Cloud console for that project:
   1. Enable the **Google Photos Library API** and **Google Drive API**.
   2. Configure an OAuth consent screen (External or Internal) if prompted and publish it. The default scopes requested by Apps Script are sufficient.

### Authorize and run the script

1. Back in Apps Script, open **Triggers** and create a time-driven trigger if you want the sync to run on a schedule (for example, every hour). You can also run it manually.
2. Run the `runDriveToPhotosSync` function once from the editor. Apps Script will prompt you to authorize the script with the necessary scopes (`https://www.googleapis.com/auth/drive.readonly`, `https://www.googleapis.com/auth/photoslibrary.appendonly`, `https://www.googleapis.com/auth/photoslibrary.sharing`, and Spreadsheet scopes for logging).
3. The first successful run will create a spreadsheet named `Drive to Photos Upload Log` (or your customized name) and store its ID in script properties for future runs.
4. Subsequent executions resume from where the last run stopped. Progress and error information is written to the log sheet and Apps Script execution logs.

## Operational notes

* The script only uploads files whose MIME type matches the supported list (JPEG, PNG, WEBP, HEIC/HEIF, and AVIF). Unsupported files are skipped and reported in the execution log.
* Uploads stop when `BATCH_SIZE` items are uploaded, when the five-minute safety runtime is reached, or when a retryable error occurs. Cursor progress is saved throughout each run so long executions resume close to where they stopped and keep the Apps Script trigger healthy.
* Update `ALBUM_NAME` to control the Google Photos album used for imports. The album is created automatically if it does not exist.
* Execution logs include periodic progress updates. Use Apps Script's execution log viewer to monitor run details.

## Troubleshooting

* If you see `Upload failed` messages, the script will retry automatically for transient errors. Non-retryable failures are written to the log sheet so the file is not retried.
* To restart the import from the beginning, clear the `DRIVE_CURSOR_TOKEN`, `DRIVE_CURSOR_INDEX`, and `ALBUM_ID` entries under **Project Settings → Script properties** and delete the rows (except the header) from the log sheet.
* When changing scopes or APIs, re-run the script to accept new authorizations.

