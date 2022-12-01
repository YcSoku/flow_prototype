import { textureFormats } from './textureFormat';

export interface TextureDataInfo {
    target: number,
    flip: boolean,
    width?: number,
    height?: number,
    format: number,
    depth?: number,
    mipLevels?: number,
    arrayLayers?: number
}

export class TextureData implements TextureDataInfo {
    target : number;
    flip : boolean;
    width : number;
    height : number;
    format : number;
    depth : number;
    mipLevels : number;
    arrayLayers : number;

    ID : WebGLTexture = 0;

    constructor(info: TextureDataInfo) {
        this.target = info.target;
        this.flip = info.flip;
        this.width = info.width ? info.width : 0;
        this.height = info.height ? info.height : 0;
        this.format = info.format;
        this.depth =  info.depth ? info.depth : 1;
        this.mipLevels = info.mipLevels ? info.mipLevels : 1;
        this.arrayLayers = info.arrayLayers ? info.arrayLayers : 1;
    }

    static Create(rc: WebGL2RenderingContext, info: TextureDataInfo) {
        let texture = new TextureData(info);
        texture.ID = rc.createTexture()!;

        if (texture.width !== 0 && texture.height !== 0) {
            rc.bindTexture(texture.target, texture.ID);
            rc.texStorage2D(texture.target, texture.mipLevels, textureFormats[texture.format].internalFormat, texture.width, texture.height);
            rc.bindTexture(info.target, null);
        }

        return texture;
    }

    FillByBuffer(rc: WebGL2RenderingContext, level: number,  width: number, height: number, pbo: WebGLBuffer) {
        let format = textureFormats[this.format];

        rc.bindBuffer(rc.PIXEL_UNPACK_BUFFER, pbo);
        rc.bindTexture(this.target, this.ID);
        if (this.flip) rc.pixelStorei(rc.UNPACK_FLIP_Y_WEBGL, true);
        rc.texImage2D(this.target, level, format.internalFormat, width, height, 0, format.format, format.type, 0);
        rc.pixelStorei(rc.UNPACK_FLIP_Y_WEBGL, false);

        if (this.mipLevels > 1) {
            rc.generateMipmap(this.target);
        }
        rc.bindBuffer(rc.PIXEL_UNPACK_BUFFER, null);
        rc.bindTexture(this.target, null);
    }
    
    FillByImage(rc: WebGL2RenderingContext, level: number, url: string) {
        
        let format = textureFormats[this.format];
        const that = this;
        const image = new Image();
        image.src = url;
        image.onload = function() {
            rc.bindTexture(that.target, that.ID);
            if (that.flip) rc.pixelStorei(rc.UNPACK_FLIP_Y_WEBGL, true);
            rc.texImage2D(that.target, level, format.internalFormat, format.format, format.type, image)
            rc.pixelStorei(rc.UNPACK_FLIP_Y_WEBGL, false);
    
            if (that.mipLevels > 1) {
                rc.generateMipmap(that.target);
            }
            that.width = image.width;
            that.height = image.height;
        };
    }

    FillByData(rc: WebGL2RenderingContext, level: number,  width: number, height: number, data: ArrayBufferView) {
        let format = textureFormats[this.format];

        rc.bindTexture(this.target, this.ID);
        if (this.flip) rc.pixelStorei(rc.UNPACK_FLIP_Y_WEBGL, true);
        rc.texImage2D(this.target, level, format.internalFormat, width, height, 0, format.format, format.type, data);
        rc.pixelStorei(rc.UNPACK_FLIP_Y_WEBGL, false);

        if (this.mipLevels > 1) {
            rc.generateMipmap(this.target);
        }
        rc.bindTexture(this.target, null);
    }

    UpdateByBuffer(rc: WebGL2RenderingContext, level: number, xoffset: number, yoffset: number, width: number, height: number, pbo: WebGLBuffer) {

        rc.bindBuffer(rc.PIXEL_UNPACK_BUFFER, pbo);
        rc.bindTexture(this.target, this.ID);
        rc.texSubImage2D(this.target, level, xoffset, yoffset, width, height, textureFormats[this.format].format, textureFormats[this.format].type, 0);
        rc.bindBuffer(rc.PIXEL_UNPACK_BUFFER, null);
        rc.bindTexture(this.target, null);
    }

    UpdateByData(rc: WebGL2RenderingContext, level: number, xoffset: number, yoffset: number, width: number, height: number, data: ArrayBufferView) {
        
        rc.bindTexture(this.target, this.ID);
        rc.pixelStorei(rc.UNPACK_ALIGNMENT, 1);
        rc.texSubImage2D(this.target, level, xoffset, yoffset, width, height, textureFormats[this.format].format, textureFormats[this.format].type, data);
        rc.bindBuffer(rc.PIXEL_UNPACK_BUFFER, null);
    }

    Bind(rc: WebGL2RenderingContext, unit: number) {
        rc.activeTexture(rc.TEXTURE0 + unit);
        rc.bindTexture(this.target, this.ID);
    }

    Delete(rc: WebGL2RenderingContext) {
        rc.deleteTexture(this.ID);
    }
}