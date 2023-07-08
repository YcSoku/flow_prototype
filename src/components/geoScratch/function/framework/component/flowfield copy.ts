import { ScratchDataFormat } from '../../../platform/dataFormat';
import type {TextureView, TextureViewInfo} from '../../../platform/WebGL2/texture/textureView';
import { textureManager } from '../../../core/managers';
import axios from 'axios';
import {Shader} from '../../../platform/WebGL2/shader/shader';
import Worker from "./simulateParticle.worker?worker";
import { FlowFieldController, type FlowFieldConstraints } from './flowfieldController';
import type { Map } from 'mapbox-gl';
import { GUI } from 'dat.gui';

const stf = ScratchDataFormat;
const stm = textureManager;

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

class DescriptionParser {
    private url = "";

    public flowFieldResourceArray: Array<string> = [];
    public seedingResourceArray: Array<string> = [];
    public transformResourceArray: Array<string> = [];
    public maxDropRate = 0.0;
    public maxDropRateBump = 0.0;
    public maxSegmentNum = 0.0;
    public maxTrajectoryNum = 0.0;
    public maxTextureSize = 0.0;
    public extent = [0.0, 0.0, 0.0, 0.0];
    public flowBoundary = [0.0, 0.0, 0.0, 0.0];
    public flowFieldTextureSize = [0.0, 0.0];
    public seedingTextureSize = [0.0, 0.0];
    public transformTextureSize = [0.0, 0.0];

    constructor(descriptionUrl: string) {
        this.url = descriptionUrl;
    }

    async Parsing() {
        await axios.get(this.url)
        .then(async (response) => {
            this.flowBoundary[0] = response.data["flow_boundary"]["u_min"];
            this.flowBoundary[1] = response.data["flow_boundary"]["v_min"];
            this.flowBoundary[2] = response.data["flow_boundary"]["u_max"];
            this.flowBoundary[3] = response.data["flow_boundary"]["v_max"];

            this.maxTextureSize = response.data["constraints"]["max_texture_size"],
            this.maxTrajectoryNum = response.data["constraints"]["max_streamline_num"],
            this.maxSegmentNum = response.data["constraints"]["max_segment_num"],
            this.maxDropRate = response.data["constraints"]["max_drop_rate"],
            this.maxDropRateBump = response.data["constraints"]["max_drop_rate_bump"]

            this.extent[0] = response.data["extent"][0];
            this.extent[1] = response.data["extent"][1];
            this.extent[2] = response.data["extent"][2];
            this.extent[3] = response.data["extent"][3];

            for (const url of response.data["flow_fields"]) {
                this.flowFieldResourceArray.push(url);
            }
            this.flowFieldTextureSize[0] = response.data["texture_size"]["flow_field"][0];
            this.flowFieldTextureSize[1] = response.data["texture_size"]["flow_field"][1];

            for (const url of response.data["area_masks"]) {
                this.seedingResourceArray.push(url);
            }
            this.seedingTextureSize[0] = response.data["texture_size"]["area_mask"][0];
            this.seedingTextureSize[1] = response.data["texture_size"]["area_mask"][1];

            for (const url of response.data["projection"]) {
                this.transformResourceArray.push(url);
            }
            this.transformTextureSize[0] = response.data["texture_size"]["projection"][0];
            this.transformTextureSize[1] = response.data["texture_size"]["projection"][1];

        });
    }

}

export class FlowFieldManager {

    public parser: DescriptionParser;

    private renderVAO: WebGLVertexArrayObject = 0;
    private trajectoryIndexBuffer: WebGLBuffer = 0;
    private UBO: WebGLBuffer = 0;

    private drawWorkerShader: Shader | null;
    private poolShader: Shader | null;
    private textureShader: Shader | null;

    private uboMapBuffer: Float32Array;
    private particleMapBuffer : Float32Array | null;

    private maxBlockSize: number;
    private maxBlockColumn: number;
    private flowBoundary: Array<number>;
    private textureOffsetArray: Array<TextureOffset>;

    // Render variable
    private beginBlock = 0.0;
    private aliveLineNum = 0.0;
    private segmentNum = 0.0;
    private projTextureInfo = 0.0;
    private particlePool = 0;
    private needSimulate = true; 
    private canvasWitdh = 0.0;
    private canvasHeight = 0.0;
    private dc: WebGL2RenderingContext|null = null;

    public aliveWorker: Worker;
    public zoomRate = 1.0;
    public workerOK = false;
    public workerParserOK = false;
    public updateWorkerSetting = true;
    public updateProgress = false;
    public u_matrix: number[];
    public controller: FlowFieldController | null;

    constructor(descriptionUrl: string) {

        this.parser = new DescriptionParser(descriptionUrl);

        this.drawWorkerShader = null;
        this.poolShader = null;
        this.textureShader = null;
        this.particleMapBuffer = null;
        this.controller = null;
        
        this.maxBlockSize = 0.0;
        this.maxBlockColumn = 0.0;
        this.textureOffsetArray = [];
        this.u_matrix = [];
        this.flowBoundary = [];
        this.uboMapBuffer = new Float32Array(12);

        this.aliveWorker = new Worker();
    }

    static async Create(descriptionUrl: string) {

        const ffManager = new FlowFieldManager(descriptionUrl);
        await ffManager.parser.Parsing();

        // Get constraints
        const constraints: FlowFieldConstraints = {
            MAX_TEXTURE_SIZE: ffManager.parser.maxTextureSize,
            MAX_STREAMLINE_NUM: ffManager.parser.maxTrajectoryNum,
            MAX_SEGMENT_NUM: ffManager.parser.maxSegmentNum,
            MAX_DORP_RATE: ffManager.parser.maxDropRate,
            MAX_DORP_RATE_BUMP: ffManager.parser.maxDropRateBump
        }
        ffManager.controller = new FlowFieldController(constraints)!;

        // Set UI
        ffManager.UIControllerSetting();

        // Activate worker
        ffManager.aliveWorker.postMessage([-1, ffManager.parser]);
        ffManager.aliveWorker.onmessage = function(e) {
            if (e.data[0] == -1) {
                ffManager.workerParserOK = true;
            }
            if (e.data[0] == 0) {

                ffManager.workerOK = true;
            }
            if (e.data[0] == 1) {

                ffManager.beginBlock = e.data[1];
                ffManager.aliveLineNum = e.data[3];
                
                ffManager.GPUMemoryUpdate_gl(e.data[2], e.data[4]);
                ffManager.needSimulate = true;
            }
        }

        return ffManager;
    }

    async Prepare(gl: WebGL2RenderingContext) {

        this.dc = gl;

        // Set worker
        this.canvasWitdh = gl.canvas.width;
        this.canvasHeight = gl.canvas.height;
        this.aliveWorker.postMessage([0, this.canvasWitdh, this.canvasHeight]);

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
        this.flowBoundary = this.parser.flowBoundary;

        // Set uniform buffer object data (something will not change)
        this.uboMapBuffer[8] = this.flowBoundary[0];
        this.uboMapBuffer[9] = this.flowBoundary[1];
        this.uboMapBuffer[10] = this.flowBoundary[2];
        this.uboMapBuffer[11] = this.flowBoundary[3];

        // Load texture of projection
        for (const url of this.parser.transformResourceArray) {
            const tID = stm.SetTexture(stm.AddTextureView(f32TextureViewInfo), lSampler);
            await stm.FillTextureDataByImage(tID, 0, url, this.parser.transformTextureSize[0], this.parser.transformTextureSize[1]);
            this.projTextureInfo = tID;
        }

        // Prepare descriptive variables
        const MAX_TEXTURE_SIZE = this.controller!.constraints["MAX_TEXTURE_SIZE"];
        const MAX_STREAMLINE_NUM = this.controller!.constraints["MAX_STREAMLINE_NUM"];
        const MAX_SEGMENT_NUM = this.controller!.constraints["MAX_SEGMENT_NUM"];

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

        // Set Buffer used to simulation
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
        this.drawWorkerShader = await loadShader_url(gl, "draw", "http://localhost:5173/shaders/ribbonParticle.worker.vert", "http://localhost:5173/shaders/ribbonParticle.worker.frag");
        this.textureShader = await loadShader_url(gl, "textureDebug", "http://localhost:5173/shaders/texture.vert", "http://localhost:5173/shaders/texture.frag");
        this.poolShader = await loadShader_url(gl, "textureDebug", "http://localhost:5173/shaders/showPool.vert", "http://localhost:5173/shaders/showPool.frag");

    
        return true;
    }

    GPUMemoryUpdate_gl(trajectoryBlock: Float32Array, trajectoryBuffer: Float32Array) {
        const that = this;
        stm.UpdateDataBySource(that.particlePool, 0, that.textureOffsetArray[that.beginBlock].offsetX, that.textureOffsetArray[that.beginBlock].offsetY, that.maxBlockSize, that.maxBlockSize, trajectoryBlock);

        that.dc!.bindBuffer(that.dc!.ARRAY_BUFFER, that.trajectoryIndexBuffer);
        that.dc!.bufferSubData(that.dc!.ARRAY_BUFFER, 0, trajectoryBuffer);
        that.dc!.bindBuffer(that.dc!.ARRAY_BUFFER, null);
    }

    bindUBO(gl: WebGL2RenderingContext, bindingPointIndex: number) {

        gl.bindBuffer(gl.UNIFORM_BUFFER, this.UBO);
        gl.bufferSubData(gl.UNIFORM_BUFFER, 0, this.uboMapBuffer);
        gl.bindBufferRange(gl.UNIFORM_BUFFER, bindingPointIndex, this.UBO, 0, this.uboMapBuffer.length * 4.0);
    }

    tickLogicCount() {

        this.uboMapBuffer[1] = this.controller!.segmentNum;
        this.uboMapBuffer[2] = this.controller!.segmentNum * 10;
        this.uboMapBuffer[3] = this.controller!.dropRate;
        this.uboMapBuffer[4] = this.controller!.dropRateBump;
        this.uboMapBuffer[5] = this.controller!.speedFactor * 0.01 * 100;
        
        this.segmentNum = this.controller!.segmentNum;

        if (this.updateWorkerSetting == true) {
            this.aliveWorker.postMessage([2, this.controller!.lineNum, this.controller!.segmentNum, this.controller!.fullLife, this.controller!.progressRate, this.controller!.speedFactor, this.controller!.dropRate, this.controller!.dropRateBump, this.controller!.fillWidth, this.controller!.aaWidth, this.controller!.content, this.controller!.progressRate]);
            this.updateWorkerSetting = false;
        }

        if (this.updateProgress == true) {
            this.aliveWorker.postMessage([3, this.controller!.progressRate]);
            this.updateProgress = false;
        }
    }

    tickRender(gl: WebGL2RenderingContext, deltaTime = 0) {

        if (this.needSimulate) {

            this.aliveWorker.postMessage([1]);
            this.needSimulate = false;
        }

        this.bindUBO(gl, 0);

        // Pass 2 - Operation 1: Rendering
        gl.viewport(0, 0, gl.canvas.width, gl.canvas.height);
        gl.bindVertexArray(this.renderVAO);
        stm.BindTexture([this.particlePool, this.projTextureInfo], [0, 1]);

        this.drawWorkerShader!.use(gl);
        this.drawWorkerShader!.setInt(gl, "particlePool", 0);
        this.drawWorkerShader!.setInt(gl, "projectionTexture", 1);
        this.drawWorkerShader!.setInt(gl, "blockNum", this.controller!.constraints["MAX_SEGMENT_NUM"]);
        this.drawWorkerShader!.setInt(gl, "beginBlock", this.beginBlock);
        this.drawWorkerShader!.setInt(gl, "blockSize", this.maxBlockSize);
        this.drawWorkerShader!.setFloat(gl, "fillWidth", this.controller!.fillWidth);
        this.drawWorkerShader!.setFloat(gl, "aaWidth", this.controller!.aaWidth);
        this.drawWorkerShader!.setFloat2(gl, "viewport", gl.canvas.width, gl.canvas.height);
        this.drawWorkerShader!.setMat4(gl, "u_matrix", this.u_matrix);
        this.drawWorkerShader!.setUniformBlock(gl, "FlowFieldUniforms", 0);

        gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, (this.segmentNum - 1) * 2, this.aliveLineNum);
        gl.disable(gl.DEPTH_TEST);

        gl.bindVertexArray(null);
        gl.bindTexture(gl.TEXTURE_2D, null);
        gl.bindBuffer(gl.ARRAY_BUFFER, null);

        // Debug
        this.debug(gl);
    }

    debug(gl: WebGL2RenderingContext) {

        // Show particle pool
        if (this.controller!.content == "particle pool") {

            gl.enable(gl.BLEND);
            gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
            this.poolShader!.use(gl);
            stm.BindTexture([this.particlePool], [0]);
            this.poolShader!.setFloat2(gl, "viewport", window.innerWidth, window.innerHeight);
            this.poolShader!.setInt(gl, "textureBuffer", 0);
            gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, 1);
            gl.disable(gl.BLEND);
        }
        // Show flow fields
        if (this.controller!.content == "flow field") {
            
            gl.clearColor(0, 0, 0, 1);   // clear to blue
            gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
            this.textureShader!.use(gl);
            // stm.BindTexture([this.fieldSequence[0], this.fieldSequence[1]], [0, 1]);
            this.textureShader!.setInt(gl, "texture1", 0);
            this.textureShader!.setInt(gl, "texture2", 1);
            this.textureShader!.setFloat(gl, "progress", 0.0);
            this.textureShader!.setFloat2(gl, "viewport", window.innerWidth, window.innerHeight);
            gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, 1);
        }
    }

    UIControllerSetting() {

        const ffController = this.controller! as any;
        
        const MAX_TEXTURE_SIZE = ffController.constraints["MAX_TEXTURE_SIZE"];
        const MAX_STREAMLINE_NUM = ffController.constraints["MAX_STREAMLINE_NUM"];
        const MAX_SEGMENT_NUM = ffController.constraints["MAX_SEGMENT_NUM"];
        const MAX_DORP_RATE = ffController.constraints["MAX_DORP_RATE"];
        const MAX_DORP_RATE_BUMP = ffController.constraints["MAX_DORP_RATE_BUMP"];

        // Initialize the GUI
        const gui = new GUI;
        const ffFolder = gui.addFolder('Flow Fields');
        ffFolder.add(ffController, 'progressRate', 0.0, 1.0, 0.001).onChange(()=>{this.updateProgress = true});
        ffFolder.add(ffController, 'speedFactor', 0.0, 10.0, 0.001).onChange(()=>{this.updateWorkerSetting = true});
        ffFolder.add(ffController, 'dropRate', 0.0, MAX_DORP_RATE, 0.001).onChange(()=>{this.updateWorkerSetting = true});
        ffFolder.add(ffController, 'dropRateBump', 0.0, MAX_DORP_RATE_BUMP, 0.001).onChange(()=>{this.updateWorkerSetting = true});
        ffFolder.open();
        const slFolder = gui.addFolder('Streamline');
        slFolder.add(ffController, 'lineNum', 1, MAX_STREAMLINE_NUM, 1.0).onChange(()=>{this.updateWorkerSetting = true});
        slFolder.add(ffController, 'segmentNum', 4, MAX_SEGMENT_NUM, 2.0).onChange(()=>{this.updateWorkerSetting = true});
        slFolder.add(ffController, 'fillWidth', 0.0, 10.0, 0.001).onChange(()=>{this.updateWorkerSetting = true});
        slFolder.add(ffController, 'aaWidth', 0.0, 10.0, 0.001).onChange(()=>{this.updateWorkerSetting = true});
        slFolder.open();
        const dataFolder = gui.addFolder('Rendering Data');
        dataFolder.add(ffController, 'content', ["none", "particle pool", "flow field"]).onChange(()=>{this.updateWorkerSetting = true});
        dataFolder.open();
        const workerFolder = gui.addFolder('Use Worker');
        workerFolder.add(ffController, 'worker', false).onChange(()=>{this.updateWorkerSetting = true});
        workerFolder.open();
        
    }
}

export { FlowFieldController };
