# BYMARCCC Virtual Try-On assets

One folder per PHYSICAL garment:

    assets/try-on/black-baby-top/
        garment.png, garment-2.png   blank garment reference photos (transparent background)
        fit-reference.jpg            the same garment worn by a model, artwork removed (fit + hem height only)
        prints/print-0N-*.png        ORIGINAL printed artworks (transparent PNG)
        embroidery/embroidery-0N-*.png  ORIGINAL embroideries (transparent PNG)

The garment is described once in `assets/catalog.js` → `"tryOnGarments"`; each product lists its designs in
`"tryOn"` with the PNG, the artwork box inside the PNG, and its real size/position on the body (see the comment at the
top of `assets/catalog.js`). Adding a design = add the PNG + one entry there.

The artwork is never redrawn by AI: OpenAI dresses the customer in the blank garment and marks where the design goes;
the site measures the garment in that photo, places the ORIGINAL PNG at the design's real scale, and bends/shades it
with the fabric (arms/hair stay in front).
