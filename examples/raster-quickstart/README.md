# Display a COG

This focused example accepts an explicit COG media type, structurally inspects
the asset through a caller-provided decoder, and mounts only bounded viewport
windows. The session refuses ordinary GeoTIFFs and servers that ignore Range
requests.

The complete inline example is [`src/main.ts`](./src/main.ts). For STAC asset
selection, planning, expected output, and troubleshooting, continue with the
[`STAC-to-COG walkthrough`](../../docs/walkthroughs/stac-to-cog-raster.md).

