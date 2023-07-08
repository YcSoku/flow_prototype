import { FlowFieldManager } from './flowfield';
import { CustomLayer } from './customLayer';
import { GUI } from 'dat.gui'
import { Map } from 'mapbox-gl';
import { textureManager } from '../geoScratch/core/managers';
import { Shader } from '../geoScratch/platform/WebGL2/shader/shader';
import type { TextureViewInfo } from '../geoScratch/platform/WebGL2/texture/textureView';
import { ScratchDataFormat } from '../geoScratch/platform/dataFormat';
import axios from 'axios';

const stf = ScratchDataFormat;
const stm = textureManager;

function renderContextSetting (gl: WebGL2RenderingContext) {
    const available_extensions = gl.getSupportedExtensions()!;
    for (const extension of available_extensions)
    {
        gl.getExtension(extension);
    }
    textureManager.SetContext(gl);

}

async function loadShader_url(gl: WebGL2RenderingContext, name: string, vertexUrl: string, fragmentUrl: string, transformFeedbackVaryings?: Array<string>) : Promise<Shader>{

    const vertexSource = await axios.get(vertexUrl)
    .then((response) => {
        return response.data;
    });
    const fragmentSource = await axios.get(fragmentUrl)
    .then((response) => {
        return response.data;
    });

    return new Shader(gl, name, [vertexSource, fragmentSource], transformFeedbackVaryings);
}

function makeBufferBySize(gl: WebGL2RenderingContext, target: number, dataSize: number, usage: number): WebGLBuffer | null {

    const vbo = gl.createBuffer();
    if (vbo == null) {
        console.log("ERROR::Vertex Buffer cannot be created!");
        return vbo;
    }

    gl.bindBuffer(target, vbo);
    gl.bufferData(target, dataSize, usage);
    gl.bindBuffer(target, null);
    return vbo;
}

interface TextureOffset {

    offsetX: number;
    offsetY: number;
}

class FlowLayer extends CustomLayer {
    public map: mapboxgl.Map | null = null;
    public ready = false;
    public useWorker = false;


    private renderVAO: WebGLVertexArrayObject = 0;
    private trajectoryIndexBuffer: WebGLBuffer = 0;
    private UBO: WebGLBuffer = 0;

    private drawWorkerShader: Shader | null = null;
    private drawDeckShader: Shader | null = null;
    private poolShader: Shader | null = null;
    private textureShader: Shader | null = null;

    private uboMapBuffer: Float32Array;
    private particleMapBuffer : Float32Array | null = null;

    private maxBlockSize: number = 0;
    private maxBlockColumn: number = 0;
    private flowBoundary: Array<number> = [];
    private textureOffsetArray: Array<TextureOffset>;

    // Render variable
    private segmentPrepare = 0.0;
    private beginBlock = 0.0;
    private aliveLineNum = 0.0;
    private segmentNum = 0.0;
    private projTextureInfo = 0.0;
    private particlePool = 0;
    private needSimulate = true; 
    private canvasWitdh = 0.0;
    private canvasHeight = 0.0;
    private dc: WebGL2RenderingContext|null = null;

    public zoomRate = 1.0;
    public workerOK = false;
    public workerParserOK = false;
    public updateWorkerSetting = true;
    public updateProgress = false;


    constructor(
        id: string, renderingMode: '2d' | '3d',
        public ffManager: FlowFieldManager
    ) {
        super(id, renderingMode);

        this.maxBlockSize = 0.0;
        this.maxBlockColumn = 0.0;
        this.textureOffsetArray = [];
        this.flowBoundary = [];
        this.uboMapBuffer = new Float32Array(12);
    }

    async Prepare(gl: WebGL2RenderingContext) {

        this.dc = gl;

        // Set worker
        this.canvasWitdh = gl.canvas.width;
        this.canvasHeight = gl.canvas.height;
        if (!this.ffManager.workerOK)
            this.ffManager.aliveWorker.postMessage([0, this.canvasWitdh, this.canvasHeight]);

        const f32TextureViewInfo: TextureViewInfo = {
            textureDataInfo: {
                target: gl.TEXTURE_2D, 
                flip: true,
                format: stf.R32G32_SFLOAT},
            viewType: gl.TEXTURE_2D,
            format: stf.R32G32_SFLOAT
        };
        const nSampler = stm.AddSampler({
            magFilter: gl.NEAREST,
            minFilter: gl.NEAREST,
            addressModeU: gl.CLAMP_TO_EDGE,
            addressModeV: gl.CLAMP_TO_EDGE
        });
        const lSampler = stm.AddSampler({
            magFilter: gl.LINEAR,
            minFilter: gl.LINEAR,
            addressModeU: gl.CLAMP_TO_EDGE,
            addressModeV: gl.CLAMP_TO_EDGE
        });

        // Get boundaries of flow speed
        this.flowBoundary = this.ffManager.parser.flowBoundary;

        // Set uniform buffer object data (something will not change)
        this.uboMapBuffer[8] = this.flowBoundary[0];
        this.uboMapBuffer[9] = this.flowBoundary[1];
        this.uboMapBuffer[10] = this.flowBoundary[2];
        this.uboMapBuffer[11] = this.flowBoundary[3];

        console.log(stm.GetTextureViewLength());
        // Load texture of transform
        const tID = stm.SetTexture(stm.AddTextureView(f32TextureViewInfo), lSampler);
        await stm.FillTextureDataByImage(tID, 0, this.ffManager.parser.transform2DResource, this.ffManager.parser.transformTextureSize[0], this.ffManager.parser.transformTextureSize[1]);
        this.projTextureInfo = tID;

        // Prepare descriptive variables
        const MAX_TEXTURE_SIZE = this.ffManager.controller!.constraints["MAX_TEXTURE_SIZE"];
        const MAX_STREAMLINE_NUM = this.ffManager.controller!.constraints["MAX_STREAMLINE_NUM"];
        const MAX_SEGMENT_NUM = this.ffManager.controller!.constraints["MAX_SEGMENT_NUM"];

        this.maxBlockSize = Math.ceil(Math.sqrt(MAX_STREAMLINE_NUM))
        this.maxBlockColumn =  Math.floor(MAX_TEXTURE_SIZE / this.maxBlockSize);
        for (let i = 0; i < MAX_SEGMENT_NUM; i++) {
            const offset: TextureOffset = {
                offsetX: (i % this.maxBlockColumn) * this.maxBlockSize,
                offsetY: Math.floor(i / this.maxBlockColumn) * this.maxBlockSize
            };

            this.textureOffsetArray.push(offset);
        }

        // Set data of particle block used to fill simulation buffer and particle pool texture
        this.particleMapBuffer = new Float32Array(this.maxBlockSize * this.maxBlockSize * 3).fill(0);

        // Set buffer used for visual effects
        this.trajectoryIndexBuffer = makeBufferBySize(gl, gl.ARRAY_BUFFER, MAX_STREAMLINE_NUM * 4, gl.DYNAMIC_DRAW)!;

        // Make uniform buffer object
        this.UBO = gl.createBuffer()!;
        gl.bindBuffer(gl.ARRAY_BUFFER, this.UBO);
        gl.bufferData(gl.ARRAY_BUFFER, 48, gl.DYNAMIC_DRAW);
        gl.bindBuffer(gl.ARRAY_BUFFER, null);

        // Set particle pool
        const tv = stm.AddTextureView({
            textureDataInfo: {target: gl.TEXTURE_2D, 
                flip: false,
                width: MAX_TEXTURE_SIZE,
                height: MAX_TEXTURE_SIZE,
                format: stf.R32G32B32_SFLOAT},
            viewType: gl.TEXTURE_2D,
            format: stf.R32G32B32_SFLOAT
        });
        this.particlePool = stm.SetTexture(tv, nSampler);

        for (let i = 0; i < MAX_SEGMENT_NUM; i++) {
            stm.UpdateDataBySource(this.particlePool, 0, this.textureOffsetArray[i].offsetX, this.textureOffsetArray[i].offsetY, this.maxBlockSize, this.maxBlockSize, this.particleMapBuffer);
        }

        console.log(stm);
        // Set Vertex Array Object
        this.renderVAO = gl.createVertexArray()!;
        gl.bindVertexArray(this.renderVAO);
        gl.bindBuffer(gl.ARRAY_BUFFER, this.trajectoryIndexBuffer);
        gl.vertexAttribPointer(0, 1, gl.FLOAT, false, 1 * 4, 0);
        gl.vertexAttribDivisor(0, 1);
        gl.enableVertexAttribArray(0);
        gl.bindVertexArray(null);
        gl.bindBuffer(gl.ARRAY_BUFFER, null);

        // Build Shaders
        this.drawWorkerShader = await loadShader_url(gl, "draw", "http://localhost:5173/shaders/ribbonParticle.trajectory.vert", "http://localhost:5173/shaders/ribbonParticle.trajectory.frag");
        this.drawDeckShader = await loadShader_url(gl, "draw", "http://localhost:5173/shaders/ribbonParticle.point.vert", "http://localhost:5173/shaders/ribbonParticle.point.frag");
        this.textureShader = await loadShader_url(gl, "textureDebug", "http://localhost:5173/shaders/texture.vert", "http://localhost:5173/shaders/texture.frag");
        this.poolShader = await loadShader_url(gl, "textureDebug", "http://localhost:5173/shaders/showPool.vert", "http://localhost:5173/shaders/showPool.frag");

        gl.bindBuffer(gl.ARRAY_BUFFER, null);
        gl.bindBuffer(gl.TRANSFORM_FEEDBACK_BUFFER, null);
        gl.bindVertexArray(null);

        this.segmentPrepare = MAX_SEGMENT_NUM;
        this.ffManager.aliveWorker.postMessage([4, false]);
        this.ffManager.isSuspended = false;

        return true;
    }

    GPUMemoryUpdate(beginBlock: number, trajectoryBlock: Float32Array, aliveLineNum: number, trajectoryBuffer: Float32Array) {
        this.beginBlock = beginBlock;
        this.aliveLineNum = aliveLineNum;

        stm.UpdateDataBySource(this.particlePool, 0, this.textureOffsetArray[this.beginBlock].offsetX, this.textureOffsetArray[this.beginBlock].offsetY, this.maxBlockSize, this.maxBlockSize, trajectoryBlock);

        this.dc!.bindBuffer(this.dc!.ARRAY_BUFFER, this.trajectoryIndexBuffer);
        this.dc!.bufferSubData(this.dc!.ARRAY_BUFFER, 0, trajectoryBuffer);
        this.dc!.bindBuffer(this.dc!.ARRAY_BUFFER, null);
        this.map?.triggerRepaint();
    }

    bindUBO(gl: WebGL2RenderingContext, bindingPointIndex: number) {

        gl.bindBuffer(gl.UNIFORM_BUFFER, this.UBO);
        gl.bufferSubData(gl.UNIFORM_BUFFER, 0, this.uboMapBuffer);
        gl.bindBufferRange(gl.UNIFORM_BUFFER, bindingPointIndex, this.UBO, 0, this.uboMapBuffer.length * 4.0);
    }

    tickLogicCount() {
        
        this.segmentNum = this.ffManager.controller!.segmentNum;

        this.uboMapBuffer[1] = this.ffManager.controller!.segmentNum;
        this.uboMapBuffer[2] = this.ffManager.controller!.segmentNum * 10;
        this.uboMapBuffer[3] = this.ffManager.controller!.dropRate;
        this.uboMapBuffer[4] = this.ffManager.controller!.dropRateBump;
        this.uboMapBuffer[5] = this.ffManager.controller!.speedFactor * 0.01 * 100;
        this.uboMapBuffer[6] = this.ffManager.controller!.colorScheme;
    }

    tickRender(gl: WebGL2RenderingContext, u_matrix: number[]) {

        // gl.clearColor(0.0, 0.0, 0.0, 1.0);
        // gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);

        if (this.needSimulate) {

            this.ffManager.aliveWorker.postMessage([1]);
            this.needSimulate = false;
        }

        this.bindUBO(gl, 0);

        // Pass 2 - Operation 1: Rendering
        gl.viewport(0, 0, gl.canvas.width, gl.canvas.height);
        gl.bindVertexArray(this.renderVAO);
        stm.BindTexture([this.particlePool, this.projTextureInfo], [0, 1]);

        if (this.ffManager.controller!.primitive == "trajectory") {
            gl.enable(gl.BLEND);
            gl.blendColor(0.0, 0.0, 0.0, 0.0);
            gl.blendEquation(gl.FUNC_ADD);
            gl.blendFuncSeparate(gl.ONE, gl.ONE_MINUS_SRC_ALPHA, gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
            this.drawWorkerShader!.use();
            this.drawWorkerShader!.setInt("particlePool", 0);
            this.drawWorkerShader!.setInt("projectionTexture", 1);
            this.drawWorkerShader!.setInt("blockNum", this.ffManager.controller!.constraints["MAX_SEGMENT_NUM"]);
            this.drawWorkerShader!.setInt("beginBlock", this.beginBlock);
            this.drawWorkerShader!.setInt("blockSize", this.maxBlockSize);
            this.drawWorkerShader!.setFloat("fillWidth", this.ffManager.controller!.fillWidth);
            this.drawWorkerShader!.setFloat("aaWidth", this.ffManager.controller!.aaWidth);
            this.drawWorkerShader!.setFloat2("viewport", gl.canvas.width, gl.canvas.height);
            this.drawWorkerShader!.setMat4("u_matrix", u_matrix);
            this.drawWorkerShader!.setUniformBlock("FlowFieldUniforms", 0);

            gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, (this.segmentNum - 1) * 2, this.aliveLineNum);
            gl.disable(gl.DEPTH_TEST);
            gl.disable(gl.BLEND);

            gl.bindVertexArray(null);
            gl.bindTexture(gl.TEXTURE_2D, null);
            gl.bindBuffer(gl.ARRAY_BUFFER, null);
        }
        else {
            gl.enable(gl.BLEND);
            gl.blendColor(0.0, 0.0, 0.0, 0.0);
            gl.blendEquation(gl.FUNC_ADD);
            gl.blendFuncSeparate(gl.ONE, gl.ONE_MINUS_SRC_ALPHA, gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
            this.drawDeckShader!.use();
            this.drawDeckShader!.setInt("particlePool", 0);
            this.drawDeckShader!.setInt("projectionTexture", 1);
            this.drawDeckShader!.setInt("blockNum", this.ffManager.controller!.constraints["MAX_SEGMENT_NUM"]);
            this.drawDeckShader!.setInt("beginBlock", this.beginBlock);
            this.drawDeckShader!.setInt("blockSize", this.maxBlockSize);
            this.drawDeckShader!.setFloat("fillWidth", this.ffManager.controller!.fillWidth);
            this.drawDeckShader!.setFloat("aaWidth", this.ffManager.controller!.aaWidth);
            this.drawDeckShader!.setFloat2("viewport", gl.canvas.width, gl.canvas.height);
            this.drawDeckShader!.setMat4("u_matrix", u_matrix);
            this.drawDeckShader!.setUniformBlock("FlowFieldUniforms", 0);

            gl.drawArraysInstanced(gl.TRIANGLES, 0, 4 * this.segmentNum, this.aliveLineNum);
            gl.disable(gl.DEPTH_TEST);
            gl.disable(gl.BLEND);

            gl.bindVertexArray(null);
            gl.bindTexture(gl.TEXTURE_2D, null);
            gl.bindBuffer(gl.ARRAY_BUFFER, null);
        }

        // Debug
        this.debug(gl);
    }

    debug(gl: WebGL2RenderingContext) {

        // Show particle pool
        if (this.ffManager.controller!.content == "particle pool") {

            gl.enable(gl.BLEND);
            gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
            this.poolShader!.use();
            stm.BindTexture([this.particlePool], [0]);
            this.poolShader!.setFloat2("viewport", window.innerWidth, window.innerHeight);
            this.poolShader!.setInt("textureBuffer", 0);
            gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, 1);
            gl.disable(gl.BLEND);
        }
        // Show flow fields
        if (this.ffManager.controller!.content == "flow field") {
            
            gl.clearColor(0, 0, 0, 1);   // clear to blue
            gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
            this.textureShader!.use();
            // stm.BindTexture([this.fieldSequence[0], this.fieldSequence[1]], [0, 1]);
            this.textureShader!.setInt("texture1", 0);
            this.textureShader!.setInt("texture2", 1);
            this.textureShader!.setFloat("progress", 0.0);
            this.textureShader!.setFloat2("viewport", window.innerWidth, window.innerHeight);
            gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, 1);
        }
    }

    async onAdd(map: Map, gl: WebGL2RenderingContext) {
        console.log("Custom flow field layer is being added...");
        this.map = map;
        this.ffManager.platform = map;

        renderContextSetting(gl);
        this.ready = await this.Prepare(gl);
    }

    render(gl: WebGL2RenderingContext, u_matrix: number[]) {
        if(this.ready === false || this.ffManager.workerOK === false) {
            console.log("manager not ready !");
            return;
        }
        if (this.segmentPrepare >= 0) {
            this.ffManager.aliveWorker.postMessage([1]);
            this.map?.triggerRepaint();
            this.segmentPrepare -= 1;
            return;
        }

        this.ffManager.zoomRate = (this.map!.getZoom()) / (this.map!.getMaxZoom());
        if(this.ffManager.zoomRate <= 0.3) {
            this.ffManager.zoomRate = 10.0 / (3.0 * this.ffManager.zoomRate);
        } else if (this.ffManager.zoomRate <=0.7) {
            this.ffManager.zoomRate = 1.0;
        } else {
            this.ffManager.zoomRate = -10.0 / (3.0 * this.ffManager.zoomRate) + 10.0 / 3.0;
        }

        // rendering
        this.tickLogicCount();
        this.tickRender(gl, u_matrix);
        this.ffManager.stats.update();
    }

    onRemove(map: Map, gl: WebGL2RenderingContext): void {
        gl.deleteVertexArray(this.renderVAO);
        gl.deleteBuffer(this.UBO);
        gl.deleteBuffer(this.trajectoryIndexBuffer);
        stm.Empty();
        this.poolShader!.delete();
        this.textureShader!.delete();
        this.drawDeckShader!.delete();
        this.drawWorkerShader!.delete();
    }
}


export {
    FlowLayer
}