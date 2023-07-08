import { ScratchDataFormat } from '../../../platform/dataFormat';
import type {TextureView, TextureViewInfo} from '../../../platform/WebGL2/texture/textureView';
import { textureManager } from '../../../core/managers';
import axios from 'axios';
import {Shader} from '../../../platform/WebGL2/shader/shader';
// import Worker from "./mesh/aliveIndex.worker?worker";
import Worker from "./simulateParticle.worker?worker";

import mapboxgl from 'mapbox-gl';

const stf = ScratchDataFormat;
const stm = textureManager;

// create random positions and velocities.
const rand = (min: number, max?: number) => {
    if (!max) {
        max = min;
        min = 0;
    }
    return Math.random() * (max - min) + min;
};

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

// Data Size Constraints
interface FlowFieldConstraints {
    MAX_TEXTURE_SIZE: number;
    MAX_STREAMLINE_NUM: number;
    MAX_SEGMENT_NUM: number;
    MAX_DORP_RATE: number;
    MAX_DORP_RATE_BUMP: number;

    [name: string]: number;
}
export class FlowFieldController {
    lineNum: number;
    segmentNum: number;
    fullLife: number;
    progressRate: number;
    speedFactor: number;
    dropRate: number;
    dropRateBump: number;
    fillWidth: number;
    aaWidth: number;
    content: string;
    worker: boolean;

    constraints: FlowFieldConstraints;
    
    constructor(constraints?: FlowFieldConstraints) {
        this.lineNum = 65536;
        this.segmentNum = 16;
        this.fullLife = this.segmentNum * 10;
        this.progressRate = 0.0;
        this.speedFactor = 2.0;
        this.dropRate = 0.003;
        this.dropRateBump = 0.001;
        this.fillWidth = 1.0;
        this.aaWidth = 1.0;
        this.content = "none";
        this.worker = true;

        if (constraints) {
            this.constraints = constraints;
        } else {
            this.constraints = {
                MAX_TEXTURE_SIZE: 0.0,
                MAX_STREAMLINE_NUM: 0.0,
                MAX_SEGMENT_NUM: 0.0,
                MAX_DORP_RATE: 0.0,
                MAX_DORP_RATE_BUMP: 0.0
            }
        }
    }

    Create(constraints: FlowFieldConstraints) {
        return new FlowFieldController(constraints);
    }
}

interface TextureOffset {
    offsetX: number;
    offsetY: number;
}

interface RenderObjectSet {
    sVAO: WebGLVertexArrayObject;
    rVAO: WebGLVertexArrayObject;
    xfBO: WebGLTransformFeedback;
    pVBO: WebGLBuffer;
}

export class FlowFieldManager {
    private descriptionUrl: string;
    private fieldSequence: Array<number> = [];
    private maskSequence: Array<number> = [];
    private validSequence: Array<number> = [];

    private simulationVAO: WebGLVertexArrayObject = 0;
    private renderVAO: WebGLVertexArrayObject = 0;
    private simulationVAO2: WebGLVertexArrayObject = 0;
    private renderVAO2: WebGLVertexArrayObject = 0;
    private renderVAO3: WebGLVertexArrayObject = 0;

    private XFBO: WebGLTransformFeedback = 0;
    private XFBO2: WebGLTransformFeedback = 0;

    private simulationBuffer: WebGLBuffer = 0;
    private lifeBuffer: WebGLBuffer = 0;
    private xfSimulationBuffer: WebGLBuffer = 0;
    private xfLifeBuffer: WebGLBuffer = 0;
    private trajectoryIndexBuffer: WebGLBuffer = 0;
    private unPackBuffer: WebGLBuffer = 0;
    private lifeDataBuffer: WebGLBuffer = 0;

    private UBO: WebGLBuffer = 0;

    private updateShader: Shader | null;
    private drawShader: Shader | null;
    private drawWorkerShader: Shader | null;
    private poolShader: Shader | null;
    private textureShader: Shader | null;

    private uboMapBuffer: Float32Array;
    private particleMapBuffer : Float32Array | null;

    flowBoundary: Array<number>;
    controller: FlowFieldController | null; 

    private maxBlockSize: number;
    private maxBlockColumn: number;
    private textureOffsetArray: Array<TextureOffset>;

    // Temporary render variable
    private beginBlock = -1.0;
    private aliveLineNum = 0.0;
    private streamline = 0.0;
    private segmentNum = 0.0;
    private vaTextureInfo: number = 0; 
    private projTextureInfo: number = 0;
    private ffTextureInfo: Array<number> = []; 
    private maskTextureInfo: Array<number> = [];

    private simulationData: Float32Array;
    private lifeData: Float32Array;
    private sVAO: WebGLVertexArrayObject = 0;
    private rVAO: WebGLVertexArrayObject = 0;
    private xfBO: WebGLTransformFeedback = 0;

    private timeCount = 0;
    private timeLast = 10;

    private aliveWorker: Worker;
    private simulation_on = true; 

    public u_matrix: number[];
    public zoomRate = 1.0;
    public extent: number[];


    particlePoolView : TextureView | null = null;
    particlePool = 0;

    constructor(descriptionUrl: string) {
        this.descriptionUrl = descriptionUrl;

        this.updateShader = null;
        this.drawShader = null;
        this.drawWorkerShader = null;
        this.poolShader = null;
        this.textureShader = null;
        this.uboMapBuffer = new Float32Array(12);
        this.particleMapBuffer = null;

        this.flowBoundary = [];
        this.controller = null;

        this.maxBlockSize = 0.0;
        this.maxBlockColumn = 0.0;
        this.textureOffsetArray = [];

        this.u_matrix = [];
        this.extent = [];

        this.simulationData = new Float32Array(0);
        this.lifeData = new Float32Array(0);

        this.aliveWorker = new Worker();
    }

    static Create(descriptionUrl: string) {
        const ffManager = new FlowFieldManager(descriptionUrl);

        return ffManager;
    }

    async Prepare(gl: WebGL2RenderingContext) {

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

        const lSampler = stm.AddSampler({
            magFilter: gl.LINEAR,
            minFilter: gl.LINEAR,
            addressModeU: gl.CLAMP_TO_EDGE,
            addressModeV: gl.CLAMP_TO_EDGE
        });

        await axios.get(this.descriptionUrl)
        .then(async (response) => {
            // Get boundaries of flow speed
            this.flowBoundary[0] = response.data["flow_boundary"]["u_min"];
            this.flowBoundary[1] = response.data["flow_boundary"]["v_min"];
            this.flowBoundary[2] = response.data["flow_boundary"]["u_max"];
            this.flowBoundary[3] = response.data["flow_boundary"]["v_max"];

            // Get extent of flow field
            this.extent[0] = response.data["extent"][0];
            this.extent[1] = response.data["extent"][3];
            this.extent[2] = response.data["extent"][2];
            this.extent[3] = response.data["extent"][1];

            // Set uniform buffer object data (something will not change)
            this.uboMapBuffer[8] = this.flowBoundary[0];
            this.uboMapBuffer[9] = this.flowBoundary[1];
            this.uboMapBuffer[10] = this.flowBoundary[2];
            this.uboMapBuffer[11] = this.flowBoundary[3];

            // Get constraints
            const constraints: FlowFieldConstraints = {
                MAX_TEXTURE_SIZE: response.data["constraints"]["max_texture_size"],
                MAX_STREAMLINE_NUM: response.data["constraints"]["max_streamline_num"],
                MAX_SEGMENT_NUM: response.data["constraints"]["max_segment_num"],
                MAX_DORP_RATE: response.data["constraints"]["max_drop_rate"],
                MAX_DORP_RATE_BUMP: response.data["constraints"]["max_drop_rate_bump"]
            }

            this.controller = new FlowFieldController(constraints)!;

            // console.log(response.data["texture_size"]["flow_field"][0], response.data["texture_size"]["flow_field"][1]);
            // console.log(response.data["texture_size"]["area_mask"][0], response.data["texture_size"]["area_mask"][1]);
            // console.log(response.data["texture_size"]["valid_address"][0], response.data["texture_size"]["valid_address"][1]);

            // Load textures of flow fields
            for (const url of response.data["flow_fields"]) {
                const tID = stm.SetTexture(stm.AddTextureView(f32TextureViewInfo), nSampler);
                await stm.FillTextureDataByImage(tID, 0, url, response.data["texture_size"]["flow_field"][0], response.data["texture_size"]["flow_field"][1]);
                this.fieldSequence.push(tID);
            }

            // Load texture of projection
            for (const url of response.data["projection"]) {
                const tID = stm.SetTexture(stm.AddTextureView(f32TextureViewInfo), lSampler);
                await stm.FillTextureDataByImage(tID, 0, url, response.data["texture_size"]["projection"][0], response.data["texture_size"]["projection"][1]);
                this.projTextureInfo = tID;
            }

            // Load textures of area masks
            for (const url of response.data["area_masks"]) {
                const tID = stm.SetTexture(stm.AddTextureView(textureViewInfo), nSampler);
                await stm.FillTextureDataByImage(tID, 0, url, response.data["texture_size"]["area_mask"][0], response.data["texture_size"]["area_mask"][1]);
                this.maskSequence.push(tID);
            }

            // Load textures of valid address
            for (const url of response.data["valid_address"]) {
                const tID = stm.SetTexture(stm.AddTextureView(textureViewInfo), nSampler);
                await stm.FillTextureDataByImage(tID, 0, url, response.data["texture_size"]["valid_address"][0], response.data["texture_size"]["valid_address"][1]);
                this.validSequence.push(tID);
            }
        });

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
        for (let i = 0; i < MAX_STREAMLINE_NUM; i++) {
            this.particleMapBuffer[i * 3 + 0] = rand(0, 1.0);
            this.particleMapBuffer[i * 3 + 1] = rand(0, 1.0);
            this.particleMapBuffer[i * 3 + 2] = 0.0;
        }

        // Set life for particles
        const particleCountdownArray = new Float32Array(MAX_STREAMLINE_NUM);
        for (let i = 0; i < MAX_STREAMLINE_NUM; i++) {
            particleCountdownArray[i] = this.controller!.fullLife;
        }

        // Set Buffer used to simulation
        this.simulationBuffer = makeBufferBySource(gl, gl.ARRAY_BUFFER, this.particleMapBuffer, gl.DYNAMIC_DRAW)!;
        this.xfSimulationBuffer = makeBufferBySource(gl, gl.ARRAY_BUFFER, this.particleMapBuffer, gl.DYNAMIC_DRAW)!;
        this.lifeBuffer = makeBufferBySource(gl, gl.ARRAY_BUFFER, particleCountdownArray, gl.DYNAMIC_DRAW)!;
        this.xfLifeBuffer = makeBufferBySource(gl, gl.ARRAY_BUFFER, particleCountdownArray, gl.DYNAMIC_DRAW)!;
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
            stm.UpdateTextureDataBySource(this.particlePool, 0, this.textureOffsetArray[i].offsetX, this.textureOffsetArray[i].offsetY, this.maxBlockSize, this.maxBlockSize, this.particleMapBuffer);
        }

        // Set Vertex Array Object
        this.simulationVAO = gl.createVertexArray()!;
        gl.bindVertexArray(this.simulationVAO);
        gl.bindBuffer(gl.ARRAY_BUFFER, this.simulationBuffer);
        gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 3 * 4, 0);
        gl.enableVertexAttribArray(0);
        gl.bindBuffer(gl.ARRAY_BUFFER, this.lifeBuffer);
        gl.vertexAttribPointer(1, 1, gl.FLOAT, false, 1 * 4, 0);
        gl.enableVertexAttribArray(1);
        gl.bindVertexArray(null);
        gl.bindBuffer(gl.ARRAY_BUFFER, null);

        this.simulationVAO2 = gl.createVertexArray()!;
        gl.bindVertexArray(this.simulationVAO2);
        gl.bindBuffer(gl.ARRAY_BUFFER, this.xfSimulationBuffer);
        gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 3 * 4, 0);
        gl.enableVertexAttribArray(0);
        gl.bindBuffer(gl.ARRAY_BUFFER, this.xfLifeBuffer);
        gl.vertexAttribPointer(1, 1, gl.FLOAT, false, 1 * 4, 0);
        gl.enableVertexAttribArray(1);
        gl.bindVertexArray(null);
        gl.bindBuffer(gl.ARRAY_BUFFER, null);

        this.renderVAO = gl.createVertexArray()!;
        gl.bindVertexArray(this.renderVAO);
        gl.bindBuffer(gl.ARRAY_BUFFER, this.lifeBuffer);
        gl.vertexAttribPointer(0, 1, gl.FLOAT, false, 1 * 4, 0);
        gl.vertexAttribDivisor(0, 1);
        gl.enableVertexAttribArray(0);
        gl.bindVertexArray(null);
        gl.bindBuffer(gl.ARRAY_BUFFER, null);

        this.renderVAO2 = gl.createVertexArray()!;
        gl.bindVertexArray(this.renderVAO2);
        gl.bindBuffer(gl.ARRAY_BUFFER, this.xfLifeBuffer);
        gl.vertexAttribPointer(0, 1, gl.FLOAT, false, 1 * 4, 0);
        gl.vertexAttribDivisor(0, 1);
        gl.enableVertexAttribArray(0);
        gl.bindVertexArray(null);
        gl.bindBuffer(gl.ARRAY_BUFFER, null);

        this.renderVAO3 = gl.createVertexArray()!;
        gl.bindVertexArray(this.renderVAO3);
        gl.bindBuffer(gl.ARRAY_BUFFER, this.trajectoryIndexBuffer);
        gl.vertexAttribPointer(0, 1, gl.FLOAT, false, 1 * 4, 0);
        gl.vertexAttribDivisor(0, 1);
        gl.enableVertexAttribArray(0);
        gl.bindVertexArray(null);
        gl.bindBuffer(gl.ARRAY_BUFFER, null);

        // Set Transform Feedback Object
        this.XFBO = gl.createTransformFeedback()!;
        gl.bindTransformFeedback(gl.TRANSFORM_FEEDBACK, this.XFBO);
        gl.bindBuffer(gl.TRANSFORM_FEEDBACK_BUFFER, this.xfSimulationBuffer);
        gl.bindBufferRange(gl.TRANSFORM_FEEDBACK_BUFFER, 0, this.xfSimulationBuffer, 0, this.maxBlockSize * this.maxBlockSize * 12);
        gl.bindBuffer(gl.TRANSFORM_FEEDBACK_BUFFER, this.xfLifeBuffer);
        gl.bindBufferRange(gl.TRANSFORM_FEEDBACK_BUFFER, 1, this.xfLifeBuffer, 0, this.maxBlockSize * this.maxBlockSize * 4);
        gl.bindTransformFeedback(gl.TRANSFORM_FEEDBACK, null);
        gl.bindBuffer(gl.TRANSFORM_FEEDBACK_BUFFER, null);

        this.XFBO2 = gl.createTransformFeedback()!;
        gl.bindTransformFeedback(gl.TRANSFORM_FEEDBACK, this.XFBO2);
        gl.bindBuffer(gl.TRANSFORM_FEEDBACK_BUFFER, this.simulationBuffer);
        gl.bindBufferRange(gl.TRANSFORM_FEEDBACK_BUFFER, 0, this.simulationBuffer, 0, this.maxBlockSize * this.maxBlockSize * 12);
        gl.bindBuffer(gl.TRANSFORM_FEEDBACK_BUFFER, this.lifeBuffer);
        gl.bindBufferRange(gl.TRANSFORM_FEEDBACK_BUFFER, 1, this.lifeBuffer, 0, this.maxBlockSize * this.maxBlockSize * 4);
        gl.bindTransformFeedback(gl.TRANSFORM_FEEDBACK, null);
        gl.bindBuffer(gl.TRANSFORM_FEEDBACK_BUFFER, null);

        // Build Shaders
        this.updateShader = await loadShader_url(gl, "update", "http://localhost:5173/shaders/update.vert", "http://localhost:5173/shaders/update.frag", ['newInfo', 'aliveTime']);
        this.drawShader = await loadShader_url(gl, "draw", "http://localhost:5173/shaders/ribbonParticle.vert", "http://localhost:5173/shaders/ribbonParticle.frag");
        this.drawWorkerShader = await loadShader_url(gl, "draw", "http://localhost:5173/shaders/ribbonParticle.worker.vert", "http://localhost:5173/shaders/ribbonParticle.worker.frag");
        this.poolShader = await loadShader_url(gl, "textureDebug", "http://localhost:5173/shaders/showPool.vert", "http://localhost:5173/shaders/showPool.frag");
        this.textureShader = await loadShader_url(gl, "textureDebug", "http://localhost:5173/shaders/texture.vert", "http://localhost:5173/shaders/texture.frag");

        this.lifeData = new Float32Array(MAX_STREAMLINE_NUM);

        this.aliveWorker
    
        return true;
    }

    getFieldTexture(index: number) {
        if (index < 0 || index >= this.fieldSequence.length)
            return null;
        
        return this.fieldSequence[index];
    }

    getMaskTexture(index: number) {
        if (index < 0 || index >= this.maskSequence.length)
            return null;
        
        return this.maskSequence[index];
    }
    getValidTexture(progressRate: number) {
        const progress = progressRate * (this.fieldSequence.length - 1.0);
        const fractionalPart = progress - Math.floor(progress);

        return fractionalPart < 0.5 ? this.validSequence[Math.floor(progress)] : this.validSequence[Math.ceil(progress)];
    }

    getFieldTextures(progressRate: number) {
        const progress = progressRate * (this.fieldSequence.length - 1.0);

        return [this.fieldSequence[Math.floor(progress)], this.fieldSequence[Math.ceil(progress)]];
    }

    getMaskTextures(progressRate: number) {
        const progress = progressRate * (this.maskSequence.length - 1.0);

        return [this.maskSequence[Math.floor(progress)], this.maskSequence[Math.ceil(progress)]];
    }

    getProgressBetweenTexture(progressRate: number) {
        const progress = progressRate * (this.fieldSequence.length - 1.0);

        return progress - Math.floor(progress);
    }

    bindUBO(gl: WebGL2RenderingContext, bindingPointIndex: number) {
        gl.bindBuffer(gl.UNIFORM_BUFFER, this.UBO);
        gl.bufferSubData(gl.UNIFORM_BUFFER, 0, this.uboMapBuffer);
        gl.bindBufferRange(gl.UNIFORM_BUFFER, bindingPointIndex, this.UBO, 0, this.uboMapBuffer.length * 4.0);
    }

    swap() {
        if (this.beginBlock % 2 == 0)
        {
            this.sVAO = this.simulationVAO;
            this.rVAO = this.renderVAO;
            this.xfBO = this.XFBO;
            this.unPackBuffer = this.simulationBuffer;
            this.lifeDataBuffer = this.lifeBuffer;
        } else {
            this.sVAO = this.simulationVAO2;
            this.rVAO = this.renderVAO2;
            this.xfBO = this.XFBO2;
            this.unPackBuffer = this.xfSimulationBuffer;
            this.lifeDataBuffer = this.xfLifeBuffer;
        }
        
        this.vaTextureInfo = this.getValidTexture(this.controller!.progressRate);
        this.ffTextureInfo = this.getFieldTextures(this.controller!.progressRate);
        this.maskTextureInfo = this.getMaskTextures(this.controller!.progressRate);
    }

    step(stepSize: number) {
        this.controller!.progressRate = (this.controller!.progressRate + stepSize) - Math.floor(this.controller!.progressRate + stepSize);
    }

    tickLogic(deltaTime = 0) {
        this.step(deltaTime * 0.02);
        this.beginBlock = (this.beginBlock + 1) % this.controller!.constraints["MAX_SEGMENT_NUM"];
        this.swap();

        this.uboMapBuffer[0] = this.getProgressBetweenTexture(this.controller!.progressRate);
        this.uboMapBuffer[1] = this.controller!.segmentNum;
        this.uboMapBuffer[2] = this.controller!.segmentNum * 10;
        this.uboMapBuffer[3] = this.controller!.dropRate;
        this.uboMapBuffer[4] = this.controller!.dropRateBump;
        this.uboMapBuffer[5] = this.controller!.speedFactor * deltaTime * 100;
        
        this.streamline = this.controller!.lineNum;
        this.segmentNum = this.controller!.segmentNum;
    }

    tickLogicCount() {
        if (!this.simulation_on) return;
        this.controller!.progressRate = this.timeCount / this.timeLast;
        this.timeCount = (this.timeCount + 0.005) % this.timeLast;
        this.beginBlock = (this.beginBlock + 1) % this.controller!.constraints["MAX_SEGMENT_NUM"];
        this.swap();

        this.uboMapBuffer[0] = this.getProgressBetweenTexture(this.controller!.progressRate);
        this.uboMapBuffer[1] = this.controller!.segmentNum;
        this.uboMapBuffer[2] = this.controller!.segmentNum * 10;
        this.uboMapBuffer[3] = this.controller!.dropRate;
        this.uboMapBuffer[4] = this.controller!.dropRateBump;
        this.uboMapBuffer[5] = this.controller!.speedFactor * 0.01 * 100;
        
        this.streamline = this.controller!.lineNum;
        this.segmentNum = this.controller!.segmentNum;
    }

    tickRender(gl: WebGL2RenderingContext, deltaTime = 0) {
        if (!this.controller?.worker) {
            this.renderWithoutWorker(gl, deltaTime);
        }
        else {
            this.renderWithWorker(gl, deltaTime);
        }
    }

    renderWithoutWorker(gl: WebGL2RenderingContext, deltaTime = 0) {
        this.bindUBO(gl, 0);

        // Pass 1 - Operation 1: Simulation
        gl.bindVertexArray(this.sVAO);
        gl.bindTransformFeedback(gl.TRANSFORM_FEEDBACK, this.xfBO);
        stm.BindTexture([this.ffTextureInfo[0], this.ffTextureInfo[1], this.maskTextureInfo[0], this.maskTextureInfo[1], this.vaTextureInfo], [0, 1, 2, 3, 4]);

        this.updateShader!.use(gl);
        this.updateShader!.setVec1i(gl, "flowField", [0, 1]);
        this.updateShader!.setVec1i(gl, "mask", [2, 3]);
        this.updateShader!.setInt(gl, "validAddress", 4);
        this.updateShader!.setFloat(gl, "randomSeed", Math.random());
        this.updateShader!.setFloat2(gl, "boundary", gl.canvas.width, gl.canvas.height);
        this.updateShader!.setUniformBlock(gl, "FlowFieldUniforms", 0);

        gl.enable(gl.RASTERIZER_DISCARD);
        gl.beginTransformFeedback(gl.POINTS);
        gl.drawArrays(gl.POINTS, 0, this.streamline);
        gl.endTransformFeedback();
        gl.disable(gl.RASTERIZER_DISCARD);

        gl.bindVertexArray(null);
        gl.bindTransformFeedback(gl.TRANSFORM_FEEDBACK, null);

        // Pass 1 - Operation 2: Update particle pool
        gl.bindBuffer(gl.PIXEL_UNPACK_BUFFER, this.unPackBuffer);
        stm.UpdateDataByBuffer(this.particlePool, 0, this.textureOffsetArray[this.beginBlock].offsetX, this.textureOffsetArray[this.beginBlock].offsetY, this.maxBlockSize, this.maxBlockSize);
        gl.bindBuffer(gl.PIXEL_UNPACK_BUFFER, null);

        // Pass 2 - Operation 1: Rendering
        // gl.viewport(0, 0, gl.canvas.width, gl.canvas.height);

        // gl.clearColor(0.0, 0.0, 0.0, 1.0);
        // gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);


        gl.bindVertexArray(this.rVAO);
        stm.BindTexture([this.particlePool, this.projTextureInfo], [0, 1]);

        this.drawShader!.use(gl);
        this.drawShader!.setInt(gl, "particlePool", 0);
        this.drawShader!.setInt(gl, "projectionTexture", 1);
        this.drawShader!.setInt(gl, "blockNum", this.controller!.constraints["MAX_SEGMENT_NUM"]);
        this.drawShader!.setInt(gl, "beginBlock", this.beginBlock);
        this.drawShader!.setInt(gl, "blockSize", this.maxBlockSize);
        this.drawShader!.setFloat(gl, "fillWidth", this.controller!.fillWidth);
        this.drawShader!.setFloat(gl, "aaWidth", this.controller!.aaWidth);
        this.drawShader!.setFloat2(gl, "viewport", gl.canvas.width, gl.canvas.height);
        this.drawShader!.setVec4(gl, "extent", this.extent);
        this.drawShader!.setMat4(gl, "u_matrix", this.u_matrix);
        this.drawShader!.setUniformBlock(gl, "FlowFieldUniforms", 0);

        // gl.enable(gl.BLEND);
        // gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
        gl.enable(gl.DEPTH_TEST);
        gl.depthFunc(gl.LESS);

        gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, (this.segmentNum - 1) * 2, this.streamline);
        gl.disable(gl.DEPTH_TEST);
        // gl.disable(gl.BLEND);

        gl.bindVertexArray(null);
        gl.bindTexture(gl.TEXTURE_2D, null);
        gl.bindBuffer(gl.ARRAY_BUFFER, null);

        // Debug
        this.debug(gl);
    }

    renderWithWorker(gl: WebGL2RenderingContext, deltaTime = 0) {
        this.bindUBO(gl, 0);

        if (this.simulation_on) {
            // Pass 1 - Operation 1: Simulation
            gl.bindVertexArray(this.sVAO);
            gl.bindTransformFeedback(gl.TRANSFORM_FEEDBACK, this.xfBO);
            stm.BindTexture([this.ffTextureInfo[0], this.ffTextureInfo[1], this.maskTextureInfo[0], this.maskTextureInfo[1], this.vaTextureInfo], [0, 1, 2, 3, 4]);
    
            this.updateShader!.use(gl);
            this.updateShader!.setVec1i(gl, "flowField", [0, 1]);
            this.updateShader!.setVec1i(gl, "mask", [2, 3]);
            this.updateShader!.setInt(gl, "validAddress", 4);
            this.updateShader!.setFloat(gl, "randomSeed", Math.random());
            this.updateShader!.setFloat2(gl, "boundary", gl.canvas.width, gl.canvas.height);
            this.updateShader!.setUniformBlock(gl, "FlowFieldUniforms", 0);
    
            gl.enable(gl.RASTERIZER_DISCARD);
            gl.beginTransformFeedback(gl.POINTS);
            gl.drawArrays(gl.POINTS, 0, this.streamline);
            gl.endTransformFeedback();
            gl.disable(gl.RASTERIZER_DISCARD);
    
            gl.bindVertexArray(null);
            gl.bindTransformFeedback(gl.TRANSFORM_FEEDBACK, null);
    
            // Pass 1 - Operation 2: Update particle pool
            gl.bindBuffer(gl.PIXEL_UNPACK_BUFFER, this.unPackBuffer);
            stm.UpdateDataByBuffer(this.particlePool, 0, this.textureOffsetArray[this.beginBlock].offsetX, this.textureOffsetArray[this.beginBlock].offsetY, this.maxBlockSize, this.maxBlockSize);
            gl.bindBuffer(gl.PIXEL_UNPACK_BUFFER, null);


            this.simulation_on = false;
    
            ////
            gl.bindBuffer(gl.ARRAY_BUFFER, this.lifeDataBuffer);
            gl.getBufferSubData(gl.ARRAY_BUFFER, 0, this.lifeData, 0, this.streamline);
            gl.bindBuffer(gl.ARRAY_BUFFER, null);

            const that = this;
            this.aliveWorker.postMessage([this.streamline, this.controller!.segmentNum * 10, this.lifeData]);
            this.aliveWorker.onmessage = function(e) {
                that.aliveLineNum = e.data[0];
                gl.bindBuffer(gl.ARRAY_BUFFER, that.trajectoryIndexBuffer);
                gl.bufferSubData(gl.ARRAY_BUFFER, 0, e.data[1]);
                gl.bindBuffer(gl.ARRAY_BUFFER, null);
    
                that.simulation_on = true; 
            }
        }

        // Pass 2 - Operation 1: Rendering
        // gl.viewport(0, 0, gl.canvas.width, gl.canvas.height);

        // gl.clearColor(0.0, 0.0, 0.0, 1.0);
        // gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);


        gl.bindVertexArray(this.renderVAO3);
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
        this.drawWorkerShader!.setVec4(gl, "extent", this.extent);
        this.drawWorkerShader!.setMat4(gl, "u_matrix", this.u_matrix);
        this.drawWorkerShader!.setUniformBlock(gl, "FlowFieldUniforms", 0);

        // gl.enable(gl.BLEND);
        // gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
        gl.enable(gl.DEPTH_TEST);
        gl.depthFunc(gl.LESS);

        console.log(this.aliveLineNum / 65536);
        gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, (this.segmentNum - 1) * 2, this.aliveLineNum);
        gl.disable(gl.DEPTH_TEST);
        // gl.disable(gl.BLEND);

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
        if (0 || this.controller!.content == "flow field") {
            
            gl.clearColor(0, 0, 0, 1);   // clear to blue
            gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
            this.textureShader!.use(gl);
            stm.BindTexture([this.fieldSequence[0], this.fieldSequence[1]], [0, 1]);
            this.textureShader!.setInt(gl, "texture1", 0);
            this.textureShader!.setInt(gl, "texture2", 1);
            this.textureShader!.setFloat(gl, "progress", this.getProgressBetweenTexture(this.beginBlock));
            this.textureShader!.setFloat2(gl, "viewport", window.innerWidth, window.innerHeight);
            gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, 1);
        }
    }
}