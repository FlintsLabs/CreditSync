# Walkthrough: OCR Service Implementation

I have successfully implemented the OCR service to extract text from images (e.g., ID cards).

## Changes

### Backend
1.  **Dependencies**: Added `tesseract.js`.
2.  **Library**: Created [ocr.ts](file:///home/flintstone/github/CreditSync/backend/src/lib/ocr.ts) wrapper for Tesseract.
3.  **Storage**: Added `downloadFile` to [storage.ts](file:///home/flintstone/github/CreditSync/backend/src/lib/storage.ts) to retrieve files from MinIO.
4.  **API**: Added `POST /files/ocr` endpoint in [files.ts](file:///home/flintstone/github/CreditSync/backend/src/modules/files.ts).

## Validation

### Unit Test
I created a temporary unit test `test/ocr.test.ts` that ran Tesseract on a sample image.

**Result:**
```
✓ OCR Service > should extract text from sample image [357.84ms]
```
The service successfully initialized the worker and processed an image buffer.

## Usage
To use the OCR service:
1.  Upload a file to `/files/upload` -> returns `id` (e.g., `123`).
2.  Call `POST /files/ocr` with `{ "fileId": 123 }`.
3.  Response: `{ "success": true, "text": "Extracted Text..." }`.
