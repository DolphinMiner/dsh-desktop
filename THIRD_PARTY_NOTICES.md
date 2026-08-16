# Third-Party Notices

## DeepSeek Harness

The application icon incorporates the `FishLogo` artwork distributed with
DeepSeek Harness. The bundled runtime and that artwork are covered by the
following license.

MIT License

Copyright (c) 2026 DeepSeek

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.

Source: https://github.com/deepseek-ai/deepseek-harness/blob/master/LICENSE

## Electron and Chromium

This application is built with Electron 43.4.0. Electron's MIT license and
the notices for Chromium and its third-party components are included in the
packaged application under `Contents/Resources/THIRD_PARTY/`.

Source: https://github.com/electron/electron/tree/v43.4.0

## sharp-libvips

DeepSeek Harness uses Sharp for image processing. The Apple Silicon build
includes `@img/sharp-libvips-darwin-arm64` 1.3.2 and libvips 8.18.3 as a
dynamically linked library. Its component license matrix and the complete
GNU Lesser General Public License version 3 are included in the packaged
application under `Contents/Resources/THIRD_PARTY/`.

Corresponding source and build scripts:

- https://github.com/lovell/sharp-libvips/tree/v1.3.2
- https://github.com/libvips/libvips/tree/v8.18.3

## cron-parser and Luxon

The desktop automation scheduler uses `cron-parser` 5.7.0 and its Luxon 3.7.2
dependency for deterministic calendar evaluation and IANA time-zone handling.
Both packages are distributed under the MIT License.

- https://github.com/harrisiirak/cron-parser/tree/v5.7.0
- https://github.com/moment/luxon/tree/3.7.2

The production dependency directories retain the individual license files
shipped by their package authors.

## Playwright

The controlled Browser runtime uses `playwright-core` 1.62.1, distributed by
Microsoft under the Apache License 2.0. DSH Desktop currently launches a
supported browser already installed on the user's Mac; it does not redistribute
a Playwright browser binary.

Source: https://github.com/microsoft/playwright/tree/v1.62.1
