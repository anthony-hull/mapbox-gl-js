// @flow
import {RGBAImage} from '../util/image.js';

import {warnOnce, clamp} from '../util/util.js';
import {register} from '../util/web_worker_transfer.js';
import DemMinMaxQuadTree from './dem_tree.js';
import assert from 'assert';

// DEMData is a data structure for decoding, backfilling, and storing elevation data for processing in the hillshade shaders
// data can be populated either from a pngraw image tile or from serliazed data sent back from a worker. When data is initially
// loaded from a image tile, we decode the pixel values using the appropriate decoding formula, but we store the
// elevation data as an Int32 value. we add 65536 (2^16) to eliminate negative values and enable the use of
// integer overflow when creating the texture used in the hillshadePrepare step.

// DEMData also handles the backfilling of data from a tile's neighboring tiles. This is necessary because we use a pixel's 8
// surrounding pixel values to compute the slope at that pixel, and we cannot accurately calculate the slope at pixels on a
// tile's edge without backfilling from neighboring tiles.

export type DEMEncoding = "mapbox" | "terrarium";

const unpackVectors = {
    mapbox: [6553.6, 25.6, 0.1, 10000.0],
    terrarium: [256.0, 1.0, 1.0 / 256.0, 32768.0]
};

export default class DEMData {
    uid: number;
    pixels: Uint8Array;
    stride: number;
    dim: number;
    encoding: DEMEncoding;
    borderReady: boolean;
    _tree: DemMinMaxQuadTree;
    get tree(): DemMinMaxQuadTree {
        if (!this._tree) this._buildQuadTree();
        return this._tree;
    }

    // RGBAImage data has uniform 1px padding on all sides: square tile edge size defines stride
    // and dim is calculated as stride - 2.
    constructor(uid: number, data: ImageData, encoding: DEMEncoding, borderReady: boolean = false, buildQuadTree: boolean = false): void {
        this.uid = uid;
        if (data.height !== data.width) throw new RangeError('DEM tiles must be square');
        if (encoding && encoding !== "mapbox" && encoding !== "terrarium") return warnOnce(
            `"${encoding}" is not a valid encoding type. Valid types include "mapbox" and "terrarium".`
        );
        this.stride = data.height;
        const dim = this.dim = data.height - 2;
        const values = new Uint32Array(data.data.buffer);
        this.pixels = new Uint8Array(data.data.buffer);
        this.encoding = encoding || 'mapbox';
        this.borderReady = borderReady;

        if (borderReady) return;

        // in order to avoid flashing seams between tiles, here we are initially populating a 1px border of pixels around the image
        // with the data of the nearest pixel from the image. this data is eventually replaced when the tile's neighboring
        // tiles are loaded and the accurate data can be backfilled using DEMData#backfillBorder
        for (let x = 0; x < dim; x++) {
            // left vertical border
            values[this._idx(-1, x)] = values[this._idx(0, x)];
            // right vertical border
            values[this._idx(dim, x)] = values[this._idx(dim - 1, x)];
            // left horizontal border
            values[this._idx(x, -1)] = values[this._idx(x, 0)];
            // right horizontal border
            values[this._idx(x, dim)] = values[this._idx(x, dim - 1)];
        }
        // corners
        values[this._idx(-1, -1)] = values[this._idx(0, 0)];
        values[this._idx(dim, -1)] = values[this._idx(dim - 1, 0)];
        values[this._idx(-1, dim)] = values[this._idx(0, dim - 1)];
        values[this._idx(dim, dim)] = values[this._idx(dim - 1, dim - 1)];
        if (buildQuadTree) this._buildQuadTree();
    }

    _buildQuadTree() {
        assert(!this._tree);
        // Construct the implicit sparse quad tree by traversing mips from top to down
        this._tree = new DemMinMaxQuadTree(this);
    }

    get(x: number, y: number, clampToEdge: boolean = false): number {
        if (clampToEdge) {
            x = clamp(x, -1, this.dim);
            y = clamp(y, -1, this.dim);
        }
        const index = this._idx(x, y) * 4;
        const unpack = this.encoding === "terrarium" ? this._unpackTerrarium : this._unpackMapbox;
        return unpack(this.pixels[index], this.pixels[index + 1], this.pixels[index + 2]);
    }

    static getUnpackVector(encoding: DEMEncoding): [number, number, number, number] {
        return unpackVectors[encoding];
    }

    get unpackVector(): [number, number, number, number] {
        return unpackVectors[this.encoding];
    }

    _idx(x: number, y: number): number {
        if (x < -1 || x >= this.dim + 1 ||  y < -1 || y >= this.dim + 1) throw new RangeError('out of range source coordinates for DEM data');
        return (y + 1) * this.stride + (x + 1);
    }

    _unpackMapbox(r: number, g: number, b: number): number {
        // unpacking formula for mapbox.terrain-rgb:
        // https://www.mapbox.com/help/access-elevation-data/#mapbox-terrain-rgb
        return ((r * 256 * 256 + g * 256.0 + b) / 10.0 - 10000.0);
    }

    _unpackTerrarium(r: number, g: number, b: number): number {
        // unpacking formula for mapzen terrarium:
        // https://aws.amazon.com/public-datasets/terrain/
        return ((r * 256 + g + b / 256) - 32768.0);
    }

    static pack(altitude: number, encoding: DEMEncoding): [number, number, number, number] {
        const color = [0, 0, 0, 0];
        const vector = DEMData.getUnpackVector(encoding);
        let v = Math.floor((altitude + vector[3]) / vector[2]);
        color[2] = v % 256;
        v = Math.floor(v / 256);
        color[1] = v % 256;
        v = Math.floor(v / 256);
        color[0] = v;
        return color;
    }

    getPixels(): RGBAImage {
        return new RGBAImage({width: this.stride, height: this.stride}, this.pixels);
    }

    backfillBorder(borderTile: DEMData, dx: number, dy: number) {
        if (this.dim !== borderTile.dim) throw new Error('dem dimension mismatch');

        let xMin = dx * this.dim,
            xMax = dx * this.dim + this.dim,
            yMin = dy * this.dim,
            yMax = dy * this.dim + this.dim;

        switch (dx) {
        case -1:
            xMin = xMax - 1;
            break;
        case 1:
            xMax = xMin + 1;
            break;
        }

        switch (dy) {
        case -1:
            yMin = yMax - 1;
            break;
        case 1:
            yMax = yMin + 1;
            break;
        }

        const ox = -dx * this.dim;
        const oy = -dy * this.dim;
        for (let y = yMin; y < yMax; y++) {
            for (let x = xMin; x < xMax; x++) {
                const i = 4 * this._idx(x, y);
                const j = 4 * this._idx(x + ox, y + oy);
                this.pixels[i + 0] = borderTile.pixels[j + 0];
                this.pixels[i + 1] = borderTile.pixels[j + 1];
                this.pixels[i + 2] = borderTile.pixels[j + 2];
                this.pixels[i + 3] = borderTile.pixels[j + 3];
            }
        }
    }

    onDeserialize() {
        if (this._tree) this._tree.dem = this;
    }
}

register('DEMData', DEMData);
register('DemMinMaxQuadTree', DemMinMaxQuadTree, {omit: ['dem']});
