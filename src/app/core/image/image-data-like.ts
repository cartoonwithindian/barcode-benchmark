/**
 * Structural subset of the DOM ImageData type. Used so preprocessing helpers
 * can accept any raster buffer without depending directly on the DOM class.
 */
export interface ImageDataLike {
  readonly width: number;
  readonly height: number;
  readonly data: Uint8ClampedArray;
}
