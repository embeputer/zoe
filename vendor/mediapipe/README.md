# Vendored MediaPipe

These files are vendored from the public `@mediapipe/*` npm packages so the app
serves every MediaPipe runtime asset from its own origin — no CDN dependency.

| Package | Version | Path |
| --- | --- | --- |
| `@mediapipe/hands` | `0.4.1675469240` | `hands/` |
| `@mediapipe/camera_utils` | `0.3.1675466862` | `camera_utils/` |
| `@mediapipe/drawing_utils` | `0.3.1675466124` | `drawing_utils/` |
| `@mediapipe/tasks-vision` | `0.10.18` | `tasks-vision/` |

MediaPipe is released under the Apache License 2.0:
https://github.com/google-ai-edge/mediapipe/blob/master/LICENSE

To update, download the matching npm tarballs (`npm pack @mediapipe/<name>@<version>`),
replace the files here, and bump the versions in this table and in `index.html`,
`app.js`, and `debug.js`.
