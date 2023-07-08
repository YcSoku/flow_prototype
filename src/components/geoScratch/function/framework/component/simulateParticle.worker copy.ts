import { Shader } from "../../../platform/WebGL2/shader/shader";
import { TextureManager } from '@/components/geoScratch/core/texture/textureManager';
import { ScratchDataFormat } from '../../../platform/dataFormat';
import type {TextureView, TextureViewInfo} from '../../../platform/WebGL2/texture/textureView';
import axios from "axios";

const canvas = new OffscreenCanvas(100, 100);
const gl = canvas.getContext("webgl2") as WebGL2RenderingContext;
const stf = ScratchDataFormat;
const stm = TextureManager.Create(200, 16, 200); stm.SetContext(gl);

let shader: Shader;

// create random positions and velocities.
const rand = (min: number, max?: number) => {
    if (!max) {
        max = min;
        min = 0;
    }
    return Math.random() * (max - min) + min;
};

function makeBufferBySource(gl: WebGL2RenderingContext, target: number, srcData: ArrayBuffer, usage: number): WebGLBuffer | null {
    const vbo = gl.createBuffer();
    if (vbo == null) {
        console.log("ERROR::Vertex Buffer cannot be created!");
        return vbo;
    }

    gl.bindBuffer(target, vbo);
    gl.bufferData(target, srcData, usage);
    gl.bindBuffer(target, null);
    return vbo;
}

async function prepare(descriptions: any) {

    // Create shader
    const vertexSource = await axios.get("http://localhost:5173/shaders/update.vert")
    .then((response) => {
        return response.data;
    });
    const fragmentSource = await axios.get("http://localhost:5173/shaders/update.frag")
    .then((response) => {
        return response.data;
    });
    shader = new Shader(gl, "simulation", [vertexSource, fragmentSource], ['newInfo', 'aliveTime']);

    // Create sampler
        const f32TextureViewInfo: TextureViewInfo = {
            textureDataInfo: {
                target: gl.TEXTURE_2D, 
                flip: true,
                format: stf.R32G32_SFLOAT},
            viewType: gl.TEXTURE_2D,
            format: stf.R32G32_SFLOAT
        };
        const textureViewInfo: TextureViewInfo = {
            textureDataInfo: {
                target: gl.TEXTURE_2D, 
                flip: true,
                format: stf.R8G8B8A8_UBYTE},
            viewType: gl.TEXTURE_2D,
            format: stf.R8G8B8A8_UBYTE
        };
        const nSampler = stm.AddSampler({
            magFilter: gl.NEAREST,
            minFilter: gl.NEAREST,
            addressModeU: gl.CLAMP_TO_EDGE,
            addressModeV: gl.CLAMP_TO_EDGE
        });
}


onmessage = function(e) {
    
}