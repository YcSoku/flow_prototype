export var ScratchTextureFormat = {
    R8G8B8A8_UBYTE: 0,
    R32G32B32_FLOAT: 1
}

export interface TextureFormat {
    internalFormat: number,
    format: number,
    type: number
}

export interface TextureFormats {
    [formatName: number]: TextureFormat
}

export var textureFormats: TextureFormats = {};

const tf = ScratchTextureFormat;
textureFormats[tf.R8G8B8A8_UBYTE] = {
    internalFormat: WebGL2RenderingContext.RGBA8,
    format: WebGL2RenderingContext.RGBA,
    type: WebGL2RenderingContext.UNSIGNED_BYTE
}
textureFormats[tf.R32G32B32_FLOAT] = {
    internalFormat: WebGL2RenderingContext.RGB32F,
    format: WebGL2RenderingContext.RGB,
    type: WebGL2RenderingContext.FLOAT
}