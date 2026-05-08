const { fromArrayBuffer } = require('geotiff');
const fs = require('fs');
(async () => {
  const buffer = fs.readFileSync('./public/data/t1aggEBKlogHI.tif');
  const tiff = await fromArrayBuffer(buffer);
  const image = await tiff.getImage();
  console.log('origin', image.getOrigin());
  console.log('resolution', image.getResolution());
  console.log('bbox', image.getBoundingBox());
  console.log('width,height', image.getWidth(), image.getHeight());
})();
