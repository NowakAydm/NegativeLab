# Negative Lab

Negative Lab is a browser-based film-negative scanner. It captures frames from a camera, detects and rectifies film frames, lets you refine crops and color, and exports processed positives as PNGs. Capture and image processing run locally in your browser.

## Requirements

- A modern browser with camera and Canvas support. Recent Chrome or Edge is recommended; some optional features, such as choosing an export folder, are browser-dependent.
- A camera or video source that can show a negative over a backlight.
- An internet connection when loading the app, because Tailwind CSS and OpenCV.js are loaded from CDNs.
- Serve the app from `localhost` or HTTPS to use the camera. Browsers generally block camera access from a `file://` page.

## Run locally

There is no build step or package installation. Just open the `index.html` file.

Allow camera access when prompted. Capture can begin as soon as the camera is ready; OpenCV.js initializes separately for image processing.

## Workflow

1. **Setup**
   - Start the camera and choose a video source and resolution. If the requested resolution is unavailable, the app tries lower resolutions and reports the actual stream size.
   - Place the negative and its light source in view.
   - Optionally enable **Decode Z-Log2 input** for Z CAM Z-Log2 footage. This affects image processing, not the capture and review previews.
   - Choose from 1 to 16 frames per burst.
2. **Capture**
   - Press **Capture burst** or the Space key. Captured frames use a default inset crop that you can adjust manually in Review.
   - Press **Import image** to add PNG, JPEG, or WebP files as single-frame shots covering the whole image, for reprocessing exported assets. Exported positives are already inverted, so turn off **Invert negative** for those rolls.
   - Create and name multiple rolls as needed. Captures stay in memory for the current page session.
3. **Review**
   - Select a shot and adjust its crop using the four corners, or use the film-edge guides for a 3:2 crop.
   - Flip the result horizontally or vertically, reset to the default crop, or remove a failed or duplicate shot.
   - The color-corrected review option is only a preview; it does not change the captured data or exported image.
4. **Process**
   - Choose color or black-and-white output, then adjust levels, brightness, contrast, tint, and RGB/master curves. Adjustments can apply to the roll or to an individual shot.
   - Use **Pick white** or **Pick black**, then click the matching point in the cropped preview to set its RGB level endpoints from the original crop pixels.
   - Choose whether to invert the negative and select the output gamma.
   - Frames in a burst are averaged as they are captured, so each shot keeps one averaged image. The processing preview and export use that image.
   - Save and load color-adjustment profiles as `.txt` files.
5. **Export**
   - Export all rolls as individual PNG files or as one ZIP archive with a folder for each roll.
   - Optionally include the rectified, unprocessed negative crop alongside each positive. Raw-negative PNGs use the `_neg_` prefix.

## Data, privacy, and backups

- Camera frames are processed in the browser; this app does not upload captured images to a Negative Lab server.
- Captured frames and edits exist only in memory for the current page session. Export processed PNGs before reloading or closing the page; there is no session restore or raw-data backup.
- Each shot stores one averaged 4K RGBA image (about 32 MiB) regardless of burst size, so memory grows with the number of shots rather than with burst frames. Use a lower camera resolution if the browser becomes unstable.
- The app itself is client-side, but its Tailwind CSS and OpenCV.js dependencies are fetched from third-party CDNs when the page loads.

## Troubleshooting

- **Camera access is unavailable:** open the app through `http://localhost` or HTTPS, not `file://`; grant camera permission in the browser.
- **No camera or wrong camera:** connect or enable the device, then select it in Setup. Camera labels may appear only after permission is granted.
- **Camera will not start:** close other applications using it, reconnect the device, and try restarting the camera from Setup.
- **OpenCV remains loading:** check your internet connection and whether the OpenCV CDN is accessible, then reload the page.
- **The crop needs adjustment:** use the four crop corners in Review to frame the negative manually.
- **The browser becomes unstable on a large roll:** browser memory varies by device. Export processed images periodically and consider using a lower camera resolution or fewer frames per burst.

## Project layout

```text
index.html                       App interface and CDN dependencies
styles.css                       App styles
js/
  app.js                         App workflow, camera, state, and controls
  core/state.js                  Shared state and UI helpers
  modules/
    image-processing.js          Crop and image pipeline
    review.js                    Crop and shot-review interface
    export.js                    PNG and ZIP export
```

The scripts are loaded directly by `index.html`; no bundler or package manager is required.
