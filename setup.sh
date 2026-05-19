#!/bin/bash
# Downloads dependencies into lib/
set -e
mkdir -p lib

echo "Downloading xlsx-js-style (SheetJS fork with free cell-style support)..."
curl -L "https://cdn.jsdelivr.net/npm/xlsx-js-style@1.2.0/dist/xlsx.bundle.js" -o lib/xlsx.full.min.js

echo "Downloading JSZip (for chart image embedding)..."
curl -L "https://cdn.jsdelivr.net/npm/jszip@3.10.1/dist/jszip.min.js" -o lib/jszip.min.js

echo "Done — lib/ ready."
