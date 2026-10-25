# Negative Lab

Negative Lab is a browser-based film-negative scanner. It captures frames from a camera, detects and rectifies film frames, lets you refine crops and color, and exports processed positives as PNGs. Capture and image processing run locally in your browser.

## Requirements

- A modern browser with camera and Canvas support. Recent Chrome or Edge is recommended; some optional features, such as choosing an export folder, are browser-dependent.
- A camera or video source that can show a negative over a backlight.
- No internet connection is required: the app tries the pinned Tailwind CSS and OpenCV.js CDNs first, then falls back to local copies in `vendor/` after a load error or five-second timeout.
- Serve the app from `localhost` or HTTPS to use the camera. Browsers generally block camera access from a `file://` page.

## Run locally

There is no build step or package installation. Serve the project folder from `localhost` or HTTPS and open `index.html`.

Allow camera access when prompted. Capture can begin as soon as the camera is ready; OpenCV.js initializes separately for image processing. If both a CDN and its local fallback fail, the app displays a dependency warning.

## Workflow

1. **Setup**
   - Start the camera and choose a video source and resolution. If the requested resolution is unavailable, the app tries lower resolutions and reports the actual stream size.
   - Place the negative and its light source in view.
   - Optionally enable **Decode Z-Log2 input** for Z CAM Z-Log2 footage. The decoder uses the reverse-engineered [Z-Log2 curve](https://github.com/thatcherfreeman/zlog-curve/blob/master/dctl/zlog2_to_linear.dctl); multi-frame bursts are averaged and stored as 16-bit linear RGB.
   - Choose from 1 to 16 frames per burst.
2. **Capture**
   - Press **Capture burst** or the Space key. Captured frames use a default inset crop that you can adjust manually in Crop.
   - Press **Import image** to add PNG, JPEG, or WebP files as single-frame shots covering the whole image, for reprocessing exported assets. Exported positives are already inverted, so turn off **Invert negative** for those rolls.
   - Create and name multiple rolls as needed. Captures stay in memory for the current page session.
3. **Crop**
   - Select a shot and adjust its crop using four independent corners, **2 corners** for a rectangular crop using the top-left and bottom-right handles, or the film-edge guides for a 3:2 crop.
   - Flip the result horizontally or vertically, reset to the default crop, or remove a failed or duplicate shot.
   - The color-corrected crop preview is only a preview; it does not change the captured data or exported image.
4. **Develop**
   - Adjust levels, brightness, contrast, hue, and RGB/master curves in the resizable processing panel. Select the R/G/B/W buttons to switch the curve editor; RGB selections also show their min/max levels. Adjustments can apply to the roll or to an individual shot.
   - Levels are not scanned automatically. Use **Auto levels** to measure ranges from the selected shot only.
   - Use **Pick white** or **Pick black**, then click the matching point in the cropped preview to set its RGB level endpoints from the original crop pixels.
   - Choose whether to invert the negative, desaturate the final output for black-and-white rolls, and select the output gamma.
   - Frames in a burst are averaged as they are captured, so each shot keeps one averaged image. Z-Log2 burst assets remain linear through processing and are encoded only for previews or raw-negative PNG export.
   - Save and load color-adjustment profiles as `.txt` files.
   - Export all rolls as individual PNG files or as one ZIP archive using the controls below the preview.
   - Raw negatives are included by default; switch **Also export raw negatives** off to omit them. ZIP exports place included negatives and each roll’s global color profile (`Roll XX.txt`) in a `negatives` subfolder.

The right panel changes with the active workflow step. The app fills the browser viewport without page-level scrolling; the roll/frame browser and side-panel controls scroll within their panes.

## Data, privacy, and backups

- Camera frames are processed in the browser; this app does not upload captured images to a Negative Lab server.
- Captured frames and edits exist only in memory for the current page session. Export processed PNGs before reloading or closing the page; there is no session restore or raw-data backup.
- Standard shots store one averaged 4K RGBA image (about 32 MiB); Z-Log2 burst shots store 16-bit linear RGB (about 48 MiB). Both use one image per shot regardless of burst size. Use a lower camera resolution if the browser becomes unstable.
- Tailwind CSS 3.4.17 and OpenCV.js 4.13.0 are loaded from their CDNs first and fall back to `vendor/`; OpenCV.js includes its WebAssembly payload. License notices are in `vendor/LICENSES/`.

## Troubleshooting

- **Camera access is unavailable:** open the app through `http://localhost` or HTTPS, not `file://`; grant camera permission in the browser.
- **No camera or wrong camera:** connect or enable the device, then select it in Setup. Camera labels may appear only after permission is granted.
- **Camera will not start:** close other applications using it, reconnect the device, and try restarting the camera from Setup.
- **OpenCV remains loading:** wait for the local fallback, then check the dependency warning and the files in `vendor/`.
- **The crop needs adjustment:** use the four crop corners in Crop to frame the negative manually.
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
