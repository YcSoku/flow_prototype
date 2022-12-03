import { ScratchDataFormat, type DataFormats } from "../../dataFormat";

const tf = ScratchDataFormat;
export var Scratch_GL_Data_Formats: DataFormats = {};

Scratch_GL_Data_Formats[tf.R8G8B8A8_UBYTE] = {
    internalFormat: WebGL2RenderingContext.RGBA8,
    format: WebGL2RenderingContext.RGBA,
    type: WebGL2RenderingContext.UNSIGNED_BYTE
}
Scratch_GL_Data_Formats[tf.R32G32B32_SFLOAT] = {
    internalFormat: WebGL2RenderingContext.RGB32F,
    format: WebGL2RenderingContext.RGB,
    type: WebGL2RenderingContext.FLOAT
}