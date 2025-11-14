# Google Drive to Google Photos Importer

This Apps Script scans Google Drive for supported image files and uploads them to Google Photos while keeping track of progress in a spreadsheet. Each run resumes from the last processed Drive item so the script can be scheduled as a time-based trigger without duplicating uploads.

## Features

* **Incremental Drive scanning:** Uses the Drive API change tokens stored in script properties to resume where the previous run stopped.
* **Batch-controlled uploads:** Processes items in configurable batches so triggers stay within Apps Script execution limits.
* **Automatic album management:** Creates or reuses a Google Photos album and logs progress to a spreadsheet for auditability.

## How it works

The main entry point is [`runDriveToPhotosSync`](main.gs), which orchestrates the following steps:

1. Load configuration constants (album name, spreadsheet name, batch size) and persisted cursor information.
2. Retrieve Drive files that match the supported MIME types (JPEG, PNG, WEBP, HEIC/HEIF, AVIF).
3. Upload each file to Google Photos using the Photos Library Advanced Service and add it to the target album.
4. Record successes, skips, and failures in a Google Sheet for historical tracking.
5. Persist the Drive cursor and album ID so future executions continue seamlessly.

Because all OAuth credentials are managed by the Apps Script runtime via `ScriptApp.getOAuthToken()`, no secrets need to be stored in the repository.

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

### Configure the Google Cloud project

1. Visit [console.cloud.google.com](https://console.cloud.google.com) and switch to the project linked to your Apps Script deployment (use the project number noted above).
2. Enable the **Google Photos Library API** and **Google Drive API** from **APIs & Services → Enabled APIs & services** → **+ Enable APIs and Services**.
3. Under **APIs & Services → OAuth consent screen**:
   1. Choose **Internal** or **External** depending on your account type.
   2. Populate the application name, support email, and developer contact email.
   3. Add the default Apps Script scopes if prompted (`https://www.googleapis.com/auth/drive.readonly`, `https://www.googleapis.com/auth/photoslibrary.appendonly`, `https://www.googleapis.com/auth/photoslibrary.sharing`, and Spreadsheet scopes).
   4. Add any Google accounts that will run the script as **Test users** if the consent screen is left in testing mode.
4. No OAuth client IDs or secrets are required—the Apps Script runtime manages tokens automatically once the APIs are enabled.

### Authorize and run the script

1. Back in Apps Script, open **Triggers** and create a time-driven trigger if you want the sync to run on a schedule (for example, every hour). You can also run it manually.
2. Run the `runDriveToPhotosSync` function once from the editor. Apps Script will prompt you to authorize the script with the necessary scopes (`https://www.googleapis.com/auth/drive.readonly`, `https://www.googleapis.com/auth/photoslibrary.appendonly`, `https://www.googleapis.com/auth/photoslibrary.sharing`, and Spreadsheet scopes for logging).
3. When prompted, choose **Advanced** → **Go to *Project name*** to complete authorization if Google flags the project as unverified during testing mode.
4. The first successful run will create a spreadsheet named `Drive to Photos Upload Log` (or your customized name) and store its ID in script properties for future runs.
5. Subsequent executions resume from where the last run stopped. Progress and error information is written to the log sheet and Apps Script execution logs.

## Operational notes

* The script only uploads files whose MIME type matches the supported list (JPEG, PNG, WEBP, HEIC/HEIF, and AVIF). Unsupported files are skipped and reported in the execution log.
* Uploads stop when `BATCH_SIZE` items are uploaded, when the ~4.5 minute safety runtime is reached (leaving buffer for clean shutdown), or when a retryable error occurs. Cursor progress is saved throughout each run so long executions resume close to where they stopped and keep the Apps Script trigger healthy.
* Update `ALBUM_NAME` to control the Google Photos album used for imports. The album is created automatically if it does not exist.
* When a Google Photos album reaches the 20,000 item limit, the script automatically creates the next "part" album (for example, `From Google Drive (Part 2)`) and retries the affected uploads there.
* Execution logs include periodic progress updates. Use Apps Script's execution log viewer to monitor run details.

## Troubleshooting

* If you see `Upload failed` messages, the script will retry automatically for transient errors. Non-retryable failures are written to the log sheet so the file is not retried.
* To restart the import from the beginning, clear the `DRIVE_CURSOR_TOKEN`, `DRIVE_CURSOR_INDEX`, and `ALBUM_ID` entries under **Project Settings → Script properties** and delete the rows (except the header) from the log sheet.
* When changing scopes or APIs, re-run the script to accept new authorizations.

## Contributing

We welcome improvements! Please read the [contribution guidelines](CONTRIBUTING.md) for instructions on filing issues, proposing changes, and setting up development workflows. All contributors are expected to follow the [Code of Conduct](CODE_OF_CONDUCT.md).

## Project governance

* **License:** This project is available under the terms of the [MIT License](LICENSE).
* **Security disclosures:** If you discover a vulnerability, please open a private issue or contact the maintainers directly rather than filing a public report.
* **Community norms:** Review the [Code of Conduct](CODE_OF_CONDUCT.md) before participating in discussions or pull requests.

