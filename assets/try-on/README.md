# BYMARCCC Virtual Try-On assets

One folder per PHYSICAL garment, one transparent PNG per print:

    assets/try-on/black-crop-top/
        garment.png          ← the REAL blank garment (no print), clean, high resolution, transparent background
        front.png / back.png / side.png / three-quarter.png   ← optional extra views (improve quality, not required)
        prints/
            print-01.png     ← ORIGINAL artwork, transparent background, high resolution
            print-02.png ...

1. The garment is described once in `assets/catalog.js` → `"tryOnGarments"` (already there for `black-crop-top`).
   Extra views go in its `"views"`: `{"front": ".../garment.png", "side": ".../side.png"}`.
2. Each sellable product points to the garment + its exact print, in `assets/catalog.js` → `"products"`:

       "tryOn": { "garment": "black-crop-top", "print": "assets/try-on/black-crop-top/prints/print-03.png" }

   or, for one product sold in several designs (names = the product's `"designs"`):

       "tryOn": { "garment": "black-crop-top", "designs": { "Logo": "assets/try-on/black-crop-top/prints/print-01.png" } }

The TRY ON button appears automatically once the files exist on the site. The print is never redrawn by AI:
OpenAI dresses the customer in the blank garment and marks where the print goes; the site then warps the
original PNG onto that area (folds, lighting, arms/hair in front), so text and logos stay exact.
