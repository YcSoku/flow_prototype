import { ScratchDataFormat } from '../../../platform/dataFormat';
import type {TextureView, TextureViewInfo} from '../../../platform/WebGL2/texture/textureView';
import { TextureManager } from '../../../core/texture/textureManager';
import axios from 'axios';
import {Shader} from '../../../platform/WebGL2/shader/shader';

let particleSystem: ParticleSystem;
let canvas : OffscreenCanvas;
let gl: WebGL2RenderingContext;
const stf = ScratchDataFormat;
const stm = TextureManager.Create(200, 16, 200);

// Create random positions
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

class ParticleSystem {

    private descriptionUrl: string;
    private fieldSequence: Array<number> = [];
    private maskSequence: Array<number> = [];
    private validSequence: Array<number> = [];

    private simulationVAO: WebGLVertexArrayObject = 0;
    private simulationVAO2: WebGLVertexArrayObject = 0;
    private XFBO: WebGLTransformFeedback = 0;
    private XFBO2: WebGLTransformFeedback = 0;
    private sVAO: WebGLVertexArrayObject = 0;
    private xfBO: WebGLTransformFeedback = 0;

    private simulationBuffer: WebGLBuffer = 0;
    private lifeBuffer: WebGLBuffer = 0;
    private xfSimulationBuffer: WebGLBuffer = 0;
    private xfLifeBuffer: WebGLBuffer = 0;
    private unPackBuffer: WebGLBuffer = 0;
    private lifeDataBuffer: WebGLBuffer = 0;
    private UBO: WebGLBuffer = 0;

    private updateShader: Shader | null;

    private resourceParsed = false;

    // Render variable
    public beginBlock = -1.0;
    private streamline = 0.0;
    private maxBlockSize = 0.0;
    private vaTextureInfo = 0; 
    private timeCount = 0.0;
    private timeLast = 10.0;
    private flowFieldTextureSize = [0.0, 0.0];
    private maskTextureSize = [0.0, 0.0];
    private flowFieldResourceArray: Array<string> = [];
    private maskResourceArray: Array<string> = [];
    private ffTextureInfo: Array<number> = []; 
    private maskTextureInfo: Array<number> = [];

    private uboMapBuffer: Float32Array;
    private flowBoundary: Array<number>;
    private passTickLogic = false;

    private flowTextureSingleInfo = 0.0;
    private maskTextureSingleInfo = 0.0;

    public u_matrix: number[];
    public terminate = false;

    public particleMapBuffer: Float32Array;
    public aliveIndexData: Float32Array;
    public lifeData: Float32Array;

    public aliveLineNum = 0.0;
    public lineNum = 65536 * 4;
    public segmentNum = 16 * 4;
    public fullLife = this.segmentNum * 10;
    public maxLineNum = this.lineNum;
    public progressRate = 0.0;
    public speedFactor = 2.0;
    public dropRate = 0.003;
    public dropRateBump = 0.001;
    public fillWidth = 1.0;
    public aaWidth = 1.0;
    public zoomRate = 1.0;

    constructor(descriptionUrl: string) {
        this.descriptionUrl = descriptionUrl;
        this.updateShader = null;

        this.flowBoundary = [];
        this.u_matrix = [];

        this.uboMapBuffer = new Float32Array(12);
        this.lifeData = new Float32Array(0);
        this.aliveIndexData = new Float32Array(0);
        this.particleMapBuffer = new Float32Array(0);
    }

    static Create(descriptionUrl: string) {

        const ffManager = new ParticleSystem(descriptionUrl);
        return ffManager;
    }

    async ResourceFileParsing() {

        const that = this;

        await axios.get(this.descriptionUrl)
        .then(async (response) => {
            // Get boundaries of flow speed
            that.flowBoundary[0] = response.data["flow_boundary"]["u_min"];
            that.flowBoundary[1] = response.data["flow_boundary"]["v_min"];
            that.flowBoundary[2] = response.data["flow_boundary"]["u_max"];
            that.flowBoundary[3] = response.data["flow_boundary"]["v_max"];

            // Set uniform buffer object data (something will not change)
            that.uboMapBuffer[8] = that.flowBoundary[0];
            that.uboMapBuffer[9] = that.flowBoundary[1];
            that.uboMapBuffer[10] = that.flowBoundary[2];
            that.uboMapBuffer[11] = that.flowBoundary[3];
 
            // Prepare descriptive variables
            that.maxLineNum = response.data["constraints"]["max_streamline_num"];
            that.segmentNum = response.data["constraints"]["max_segment_num"];
            that.maxBlockSize = Math.ceil(Math.sqrt(that.maxLineNum));
            that.flowFieldTextureSize = [response.data["texture_size"]["flow_field"][0], response.data["texture_size"]["flow_field"][1]];
            that.maskTextureSize = [response.data["texture_size"]["area_mask"][0], response.data["texture_size"]["area_mask"][1]];

            // Load textures of flow fields
            for (const url of response.data["flow_fields"]) {
                that.flowFieldResourceArray.push(url);
            }

            // Load textures of area masks
            for (const url of response.data["area_masks"]) {
                that.maskResourceArray.push(url);
            }

            this.resourceParsed = true;
        });
    }

    async resourcePrepare() {
        
    }

    async Prepare() {

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

            // Set uniform buffer object data (something will not change)
            this.uboMapBuffer[8] = this.flowBoundary[0];
            this.uboMapBuffer[9] = this.flowBoundary[1];
            this.uboMapBuffer[10] = this.flowBoundary[2];
            this.uboMapBuffer[11] = this.flowBoundary[3];
 
            // Prepare descriptive variables
            this.maxLineNum = response.data["constraints"]["max_streamline_num"];
            this.segmentNum = response.data["constraints"]["max_segment_num"];
            this.maxBlockSize = Math.ceil(Math.sqrt(this.maxLineNum));

            // Load textures of flow fields
            for (const url of response.data["flow_fields"]) {
                const tID = stm.SetTexture(stm.AddTextureView(f32TextureViewInfo), lSampler);
                await stm.FillTextureDataByImage(tID, 0, url, response.data["texture_size"]["flow_field"][0], response.data["texture_size"]["flow_field"][1]);
                this.fieldSequence.push(tID);
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

        // Set data of particle block used to fill simulation buffer and particle pool texture
        this.particleMapBuffer = new Float32Array(this.maxBlockSize * this.maxBlockSize * 3).fill(0);
        for (let i = 0; i < this.maxLineNum; i++) {
            this.particleMapBuffer[i * 3 + 0] = rand(0, 1.0);
            this.particleMapBuffer[i * 3 + 1] = rand(0, 1.0);
            this.particleMapBuffer[i * 3 + 2] = 0.0;
        }

        // Set life for particles
        const particleCountdownArray = new Float32Array(this.maxLineNum);
        for (let i = 0; i < this.maxLineNum; i++) {
            particleCountdownArray[i] = this.fullLife;
        }

        // Set worker message containers
        this.lifeData = new Float32Array(this.maxLineNum);
        this.aliveIndexData = new Float32Array(this.maxLineNum);

        // Set Buffer used to simulation
        this.simulationBuffer = makeBufferBySource(gl, gl.ARRAY_BUFFER, this.particleMapBuffer, gl.DYNAMIC_DRAW)!;
        this.xfSimulationBuffer = makeBufferBySource(gl, gl.ARRAY_BUFFER, this.particleMapBuffer, gl.DYNAMIC_DRAW)!;
        this.lifeBuffer = makeBufferBySource(gl, gl.ARRAY_BUFFER, particleCountdownArray, gl.DYNAMIC_DRAW)!;
        this.xfLifeBuffer = makeBufferBySource(gl, gl.ARRAY_BUFFER, particleCountdownArray, gl.DYNAMIC_DRAW)!;

        // Make uniform buffer object
        this.UBO = gl.createBuffer()!;
        gl.bindBuffer(gl.ARRAY_BUFFER, this.UBO);
        gl.bufferData(gl.ARRAY_BUFFER, 48, gl.DYNAMIC_DRAW);
        gl.bindBuffer(gl.ARRAY_BUFFER, null);

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
        this.updateShader = await loadShader_url(gl, "update", "http://localhost:5173/shaders/update.vert", "http://localhost:5173/shaders/update.frag", ['newInfo', 'aliveTime'])!;
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

    async swap() {
        if (this.beginBlock % 2 == 0)
        {
            this.sVAO = this.simulationVAO;
            this.xfBO = this.XFBO;
            this.unPackBuffer = this.simulationBuffer;
            this.lifeDataBuffer = this.lifeBuffer;
        } else {
            this.sVAO = this.simulationVAO2;
            this.xfBO = this.XFBO2;
            this.unPackBuffer = this.xfSimulationBuffer;
            this.lifeDataBuffer = this.xfLifeBuffer;
        }
        

        // const f32TextureViewInfo: TextureViewInfo = {
        //     textureDataInfo: {
        //         target: gl.TEXTURE_2D, 
        //         flip: true,
        //         format: stf.R32G32_SFLOAT},
        //     viewType: gl.TEXTURE_2D,
        //     format: stf.R32G32_SFLOAT
        // };
        // const textureViewInfo: TextureViewInfo = {
        //     textureDataInfo: {
        //         target: gl.TEXTURE_2D, 
        //         flip: true,
        //         format: stf.R8G8B8A8_UBYTE},
        //     viewType: gl.TEXTURE_2D,
        //     format: stf.R8G8B8A8_UBYTE
        // };
        // const nSampler = stm.AddSampler({
        //     magFilter: gl.NEAREST,
        //     minFilter: gl.NEAREST,
        //     addressModeU: gl.CLAMP_TO_EDGE,
        //     addressModeV: gl.CLAMP_TO_EDGE
        // });

        // const progress = this.progressRate * (this.flowFieldResourceArray.length - 1.0);
        // const timestamps = [Math.floor(progress), Math.ceil(progress)];

        // const ftID1 = stm.SetTexture(stm.AddTextureView(f32TextureViewInfo), nSampler);
        // await stm.FillTextureDataByImage(ftID1, 0, this.flowFieldResourceArray[timestamps[0]], this.flowFieldTextureSize[0], this.flowFieldTextureSize[1]);
        // const ftID2 = stm.SetTexture(stm.AddTextureView(f32TextureViewInfo), nSampler);
        // await stm.FillTextureDataByImage(ftID2, 0, this.flowFieldResourceArray[timestamps[1]], this.flowFieldTextureSize[0], this.flowFieldTextureSize[1]);

        this.vaTextureInfo = this.getValidTexture(this.progressRate);
        this.ffTextureInfo = this.getFieldTextures(this.progressRate);
        this.maskTextureInfo = this.getMaskTextures(this.progressRate);
    }

    step(stepSize: number) {
        this.progressRate = (this.progressRate + stepSize) - Math.floor(this.progressRate + stepSize);
    }

    tickLogic(deltaTime = 0) {
        if (this.passTickLogic) return;
        
        this.step(deltaTime * 0.02);
        this.swap();

        this.uboMapBuffer[0] = this.getProgressBetweenTexture(this.progressRate);
        this.uboMapBuffer[1] = this.segmentNum;
        this.uboMapBuffer[2] = this.segmentNum * 10;
        this.uboMapBuffer[3] = this.dropRate;
        this.uboMapBuffer[4] = this.dropRateBump;
        this.uboMapBuffer[5] = this.speedFactor * deltaTime * 100;
        
        this.streamline = this.lineNum;
    }

    tickLogicCount() {
        this.progressRate = this.timeCount / this.timeLast;
        this.timeCount = (this.timeCount + 0.005) % this.timeLast;
        this.beginBlock = (this.beginBlock + 1) % this.segmentNum;
        this.swap();

        this.uboMapBuffer[0] = this.getProgressBetweenTexture(this.progressRate);
        this.uboMapBuffer[1] = this.segmentNum;
        this.uboMapBuffer[2] = this.segmentNum * 10;
        this.uboMapBuffer[3] = this.dropRate;
        this.uboMapBuffer[4] = this.dropRateBump;
        this.uboMapBuffer[5] = this.speedFactor * 0.01 * 100;
        
        this.streamline = this.lineNum;
    }

    tickRender(deltaTime = 0) {
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

        // Pass 1 - Operation 2: Get simulation data
        gl.bindBuffer(gl.ARRAY_BUFFER, this.unPackBuffer);
        gl.getBufferSubData(gl.ARRAY_BUFFER, 0, this.particleMapBuffer, 0, this.particleMapBuffer.length);

        // Pass 1 - Operation 3: Get life data
        gl.bindBuffer(gl.ARRAY_BUFFER, this.lifeDataBuffer);
        gl.getBufferSubData(gl.ARRAY_BUFFER, 0, this.lifeData, 0, this.streamline);
        gl.bindBuffer(gl.ARRAY_BUFFER, null);

        // Pass 1 - Operation 4: Get alive data
        this.aliveLineNum = 0;
        for (let i = 0; i < this.streamline; i++) {
            if (this.lifeData[i] < this.segmentNum * 10) {
                this.aliveIndexData[this.aliveLineNum] = i;
                this.aliveLineNum += 1;
            }
        }
    }
}

/////////////////////////////
/////////////////////////////
/////////////////////////////
particleSystem = ParticleSystem.Create("http://localhost:5173/json/flow_field_description.json");
onmessage = async function(e) {
    switch (e.data[0]) {
        case 0:
            canvas  = new OffscreenCanvas(e.data[1], e.data[2]);
            gl = canvas.getContext("webgl2") as WebGL2RenderingContext;
            const available_extensions = gl.getSupportedExtensions()!;
            for (const extension of available_extensions)
            {
                gl.getExtension(extension);
            }
            stm.SetContext(gl);
            await particleSystem.Prepare();
            this.postMessage([0]);
            break;
        case 1:
            particleSystem.tickLogicCount();
            particleSystem.tickRender();
            this.postMessage([1, particleSystem.beginBlock, particleSystem.particleMapBuffer, particleSystem.aliveLineNum, particleSystem.aliveIndexData]);
            break;
        case 2: 
            particleSystem.lineNum = e.data[1];
            // particleSystem.controller!.segmentNum = e.data[2];
            particleSystem.fullLife = e.data[3];
            particleSystem.progressRate = e.data[4];
            particleSystem.speedFactor = e.data[5];
            particleSystem.dropRate = e.data[6];
            particleSystem.dropRateBump = e.data[7];
            particleSystem.fillWidth = e.data[8];
            particleSystem.aaWidth = e.data[9];
            break;
    }

}