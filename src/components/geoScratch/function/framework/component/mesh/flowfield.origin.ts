
import {onMounted, ref} from 'vue';
import axios from 'axios';
import {Shader} from '../../../render/shader';
import Stats from 'three/examples/jsm/libs/stats.module';
import {GUI} from 'dat.gui'

let gl: WebGL2RenderingContext;

// create random positions and velocities.
const rand = (min: number, max: number) => {
    if (max === undefined) {
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

function loadTexture(gl: WebGL2RenderingContext, url: string, interpolationType = gl.LINEAR) {
    const textureID = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, textureID);

    const image = new Image();
    image.src = url;
    image.onload = function() {
        gl.bindTexture(gl.TEXTURE_2D, textureID);
        gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, image);
        gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);

        if (isPowerOf2(image.width) && isPowerOf2(image.height)) {
            gl.generateMipmap(gl.TEXTURE_2D);
        } else {
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, interpolationType);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, interpolationType);
        }
    };

    return textureID;

    function isPowerOf2(value: number) {
        return (value & (value - 1)) == 0;
    }
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
class FlowFieldController {
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

    constraints: FlowFieldConstraints;
    
    constructor(constraints?: FlowFieldConstraints) {
        this.lineNum = 65536;
        this.segmentNum = 64;
        this.fullLife = this.segmentNum * 3;
        this.progressRate = 0.0;
        this.speedFactor = 2.0;
        this.dropRate = 0.003;
        this.dropRateBump = 0.001;
        this.fillWidth = 1.0;
        this.aaWidth = 1.0;
        this.content = "none";

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

class FlowFieldManager {
    private descriptionUrl: string;
    private fieldSequence: Array<WebGLTexture>;
    private maskSequence: Array<WebGLTexture>;

    private simulationVAO: WebGLVertexArrayObject | null;
    private renderVAO: WebGLVertexArrayObject | null;

    private XFBO: WebGLTransformFeedback | null;

    private simulationBuffer: WebGLBuffer | null;
    private lifeBuffer: WebGLBuffer | null;
    private xfSimulationBuffer: WebGLBuffer | null;
    private xfLifeBuffer: WebGLBuffer | null;

    private poolTextureBuffer: WebGLTexture | null;

    private UBO: WebGLBuffer|null;

    private updateShader: Shader | null;
    private drawShader: Shader | null;
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
    private frameCount = 0.0;
    private streamline = 0.0;
    private segmentNum = 0.0;
    private ffTextureInfo: Array<WebGLTexture> = []; 
    private maskTextureInfo: Array<WebGLTexture> = [];

    constructor(descriptionUrl: string) {
        this.descriptionUrl = descriptionUrl;
        this.fieldSequence = [];
        this.maskSequence = [];

        this.simulationVAO = null;
        this.renderVAO = null;
        this.simulationBuffer = null;
        this.lifeBuffer = null;
        this.xfSimulationBuffer = null;
        this.xfLifeBuffer = null;
        this.poolTextureBuffer = null;
        this.XFBO = null;
        this.UBO = null;
        this.updateShader = null;
        this.drawShader = null;
        this.poolShader = null;
        this.textureShader = null;
        this.uboMapBuffer = new Float32Array(12);
        this.particleMapBuffer = null;

        this.flowBoundary = [];
        this.controller = null;

        this.maxBlockSize = 0.0;
        this.maxBlockColumn = 0.0;
        this.textureOffsetArray = [];
    }

    static async Create(gl: WebGL2RenderingContext, descriptionUrl: string) {
        const ffManager = new FlowFieldManager(descriptionUrl);
        await ffManager.Prepare(gl);

        return ffManager;
    }

    async Prepare(gl: WebGL2RenderingContext, ) {
        await axios.get(this.descriptionUrl)
        .then((response) => {
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

            // Get constraints
            const constraints: FlowFieldConstraints = {
                MAX_TEXTURE_SIZE: response.data["constraints"]["max_texture_size"],
                MAX_STREAMLINE_NUM: response.data["constraints"]["max_streamline_num"],
                MAX_SEGMENT_NUM: response.data["constraints"]["max_segment_num"],
                MAX_DORP_RATE: response.data["constraints"]["max_drop_rate"],
                MAX_DORP_RATE_BUMP: response.data["constraints"]["max_drop_rate_bump"]
            }

            this.controller = new FlowFieldController(constraints);

            // Load textures of flow fields
            for (const url of response.data["flow_fields"]) {
                this.fieldSequence.push(loadTexture(gl, url, gl.NEAREST)!);
            }

            // Load textures of area masks
            for (const url of response.data["area_masks"]) {
                this.maskSequence.push(loadTexture(gl, url, gl.NEAREST)!);
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

        // Make uniform buffer object
        this.UBO = gl.createBuffer()!;
        gl.bindBuffer(gl.UNIFORM_BUFFER, this.UBO);
        gl.bufferData(gl.UNIFORM_BUFFER, 48, gl.DYNAMIC_DRAW);
        gl.bindBuffer(gl.UNIFORM_BUFFER, null);
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
        gl.bindBufferBase(gl.UNIFORM_BUFFER, bindingPointIndex, this.UBO);
    }

    step(stepSize: number) {
        this.controller!.progressRate = (this.controller!.progressRate + stepSize) - Math.floor(this.controller!.progressRate + stepSize);
    }

    tickLogic(deltaTime: number) {
        this.step(deltaTime * 0.02);

        this.uboMapBuffer[0] = this.getProgressBetweenTexture(this.controller!.progressRate);
        this.uboMapBuffer[1] = this.controller!.segmentNum;
        this.uboMapBuffer[2] = this.controller!.segmentNum * 3;
        this.uboMapBuffer[3] = this.controller!.dropRate;
        this.uboMapBuffer[4] = this.controller!.dropRateBump;
        this.uboMapBuffer[5] = this.controller!.speedFactor * deltaTime * 100;
    }
}

const viewport = ref<HTMLCanvasElement>();

const renderWay = async() => {
    // Get WebGL2 Context
    gl = viewport.value!.getContext("webgl2", {antialias: false})!;
    gl.canvas.width = window.innerWidth * window.devicePixelRatio;
    gl.canvas.height = window.innerHeight * window.devicePixelRatio;
    const available_extensions = gl.getSupportedExtensions()!;
    for (const extension of available_extensions)
    {
        gl.getExtension(extension);
    }

    const container = document.getElementById('stats'); 
    const stats = new (Stats as any)();
    container?.appendChild( stats.dom );

    // Initialize the flow field manager
    const ffManager = await FlowFieldManager.Create(gl, "http://localhost:5173/json/flow_field_description.json");
    const ffController = ffManager.controller!;
    
    const MAX_TEXTURE_SIZE = ffController.constraints["MAX_TEXTURE_SIZE"];
    const MAX_STREAMLINE_NUM = ffController.constraints["MAX_STREAMLINE_NUM"];
    const MAX_SEGMENT_NUM = ffController.constraints["MAX_SEGMENT_NUM"];
    const MAX_DORP_RATE = ffController.constraints["MAX_DORP_RATE"];
    const MAX_DORP_RATE_BUMP = ffController.constraints["MAX_DORP_RATE_BUMP"];

    const gui = new GUI();
    const ffFolder = gui.addFolder('Flow Fields')
    ffFolder.add(ffController, 'progressRate', 0.0, 1.0, 0.001);
    ffFolder.add(ffController, 'speedFactor', 0.0, 10.0, 0.001);
    ffFolder.add(ffController, 'dropRate', 0.0, MAX_DORP_RATE, 0.001);
    ffFolder.add(ffController, 'dropRateBump', 0.0, MAX_DORP_RATE_BUMP, 0.001);
    ffFolder.open();
    const slFolder = gui.addFolder('Streamline')
    slFolder.add(ffController, 'lineNum', 100, MAX_STREAMLINE_NUM, 1.0);
    slFolder.add(ffController, 'segmentNum', 4, MAX_SEGMENT_NUM, 2.0);
    slFolder.add(ffController, 'fillWidth', 0.0, 10.0, 0.001);
    slFolder.add(ffController, 'aaWidth', 0.0, 10.0, 0.001);
    slFolder.open();
    const dataFolder = gui.addFolder('Rendering Data')
    dataFolder.add(ffController, 'content', ["none", "particle pool", "flow field"]);
    dataFolder.open();

    const maxBlockSize = Math.ceil(Math.sqrt(MAX_STREAMLINE_NUM));
    const maxBlockColumn = Math.floor(MAX_TEXTURE_SIZE / maxBlockSize);
    interface TextureOffset {
        offsetX: number;
        offsetY: number;
    }
    const textureOffsetArray: Array<TextureOffset> = [];
    for (let i = 0; i < MAX_SEGMENT_NUM; i++) {
        const offset: TextureOffset = {
            offsetX: (i % maxBlockColumn) * maxBlockSize,
            offsetY: Math.floor(i / maxBlockColumn) * maxBlockSize
        };

        textureOffsetArray.push(offset);
    }

    // Set data of particle block used to fill simulation buffer and particle pool texture
    const particleMapBuffer = new Float32Array(maxBlockSize * maxBlockSize * 3).fill(0);
    for (let i = 0; i < MAX_STREAMLINE_NUM; i++) {
        let range = 0;
        if (i % 2 == 0) {
            range = gl.canvas.width;
        }
        else {
            range = gl.canvas.height;
        }
        particleMapBuffer[i * 3 + 0] = rand(0, gl.canvas.width);
        particleMapBuffer[i * 3 + 1] = rand(0, gl.canvas.height);
        particleMapBuffer[i * 3 + 2] = rand(0, 0);
    }

    // Set coundown for particles
    const particleCountdownArray = new Float32Array(MAX_STREAMLINE_NUM);
    for (let i = 0; i < MAX_STREAMLINE_NUM; i++) {
        particleCountdownArray[i] = Math.floor(rand(0.0, ffController.fullLife));
    }

    // Buffer Storage initialization
    const MAX_BUFFER_SIZE = 1024 * 1024 * 2; // 2MB

    // Set Buffer used to simulation
    const simulationBuffer = makeBufferBySource(gl, gl.ARRAY_BUFFER, particleMapBuffer.slice(0, MAX_STREAMLINE_NUM * 3), gl.DYNAMIC_DRAW);
    const xfSimulationBuffer = makeBufferBySource(gl, gl.TRANSFORM_FEEDBACK_BUFFER, particleMapBuffer.slice(0, MAX_STREAMLINE_NUM * 3), gl.DYNAMIC_DRAW);
    const lifeBuffer = makeBufferBySource(gl, gl.ARRAY_BUFFER, particleCountdownArray, gl.DYNAMIC_DRAW);
    const xfLifeBuffer = makeBufferBySource(gl, gl.TRANSFORM_FEEDBACK_BUFFER, particleCountdownArray, gl.DYNAMIC_DRAW);

    // Set particle pool
    const poolTextureBuffer = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, poolTextureBuffer);
    gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RGB32F, MAX_TEXTURE_SIZE, MAX_TEXTURE_SIZE);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    for (let i = 0; i < MAX_SEGMENT_NUM; i++) {
        gl.texSubImage2D(gl.TEXTURE_2D, 0, textureOffsetArray[i].offsetX, textureOffsetArray[i].offsetY, maxBlockSize, maxBlockSize, gl.RGB, gl.FLOAT, particleMapBuffer);
    }
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);

    // Set Vertex Array Object
    let simulationVAO = gl.createVertexArray();
    gl.bindVertexArray(simulationVAO);
    gl.bindBuffer(gl.ARRAY_BUFFER, simulationBuffer);
    gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 3 * 4, 0);
    gl.enableVertexAttribArray(0);
    gl.bindBuffer(gl.ARRAY_BUFFER, lifeBuffer);
    gl.vertexAttribPointer(1, 1, gl.FLOAT, false, 1 * 4, 0);
    gl.enableVertexAttribArray(1);
    gl.bindVertexArray(null);
    gl.bindBuffer(gl.ARRAY_BUFFER, null);

    let renderVAO = gl.createVertexArray();
    gl.bindVertexArray(renderVAO);
    gl.bindBuffer(gl.ARRAY_BUFFER, lifeBuffer);
    gl.vertexAttribPointer(0, 1, gl.FLOAT, false, 1 * 4, 0);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribDivisor(0, 1);
    gl.bindVertexArray(null);
    gl.bindBuffer(gl.ARRAY_BUFFER, null);

    // Set Transform Feedback Object
    let tf = gl.createTransformFeedback();
    gl.bindTransformFeedback(gl.TRANSFORM_FEEDBACK, tf!);
    gl.bindBuffer(gl.TRANSFORM_FEEDBACK_BUFFER, xfSimulationBuffer);
    gl.bindBufferRange(gl.TRANSFORM_FEEDBACK_BUFFER, 0, xfSimulationBuffer, 0, MAX_STREAMLINE_NUM * 12);
    gl.bindBuffer(gl.TRANSFORM_FEEDBACK_BUFFER, xfLifeBuffer);
    gl.bindBufferRange(gl.TRANSFORM_FEEDBACK_BUFFER, 1, xfLifeBuffer, 0, MAX_STREAMLINE_NUM * 4);
    gl.bindTransformFeedback(gl.TRANSFORM_FEEDBACK, null);
    gl.bindBuffer(gl.TRANSFORM_FEEDBACK_BUFFER, null);

    // Build Shaders
    const updateShader = await loadShader_url(gl, "update", "http://localhost:5173/shaders/update.vert", "http://localhost:5173/shaders/update.frag", ['newPosition', 'aliveTime']);
    const drawShader = await loadShader_url(gl, "draw", "http://localhost:5173/shaders/ribbonParticle.vert", "http://localhost:5173/shaders/ribbonParticle.frag");
    const poolShader = await loadShader_url(gl, "textureDebug", "http://localhost:5173/shaders/showPool.vert", "http://localhost:5173/shaders/showPool.frag");
    const textureShader = await loadShader_url(gl, "textureDebug", "http://localhost:5173/shaders/texture.vert", "http://localhost:5173/shaders/texture.frag");

    // Rendering
    let frameCount = 0.0;
    let streamline = 0.0;
    let segmentNum = 0.0;
    let ffTextureInfo: Array<WebGLTexture> = [];
    let maskTextureInfo: Array<WebGLTexture> = [];
    function tick(deltaTime: number) {

        // ffManager
        ffTextureInfo = ffManager.getFieldTextures(ffController.progressRate);
        maskTextureInfo = ffManager.getMaskTextures(ffController.progressRate);
        streamline = ffController.lineNum;
        segmentNum = ffController.segmentNum;
        ffManager.bindUBO(gl, 0);

        gl.clearColor(0.0, 0.0, 0.0, 1.0);
        gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);

        // Pass 1 - Operation 1: Simulation
        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, ffTextureInfo[0]);
        gl.activeTexture(gl.TEXTURE1);
        gl.bindTexture(gl.TEXTURE_2D, maskTextureInfo[0]);
        gl.activeTexture(gl.TEXTURE2);
        gl.bindTexture(gl.TEXTURE_2D, ffTextureInfo[1]);
        gl.activeTexture(gl.TEXTURE3);
        gl.bindTexture(gl.TEXTURE_2D, maskTextureInfo[1]);
        updateShader.use(gl);
        updateShader.setInt(gl, "flowField1", 0);
        updateShader.setInt(gl, "mask1", 1);
        updateShader.setInt(gl, "flowField2", 2);
        updateShader.setInt(gl, "mask2", 3);
        updateShader.setFloat(gl, "randomSeed", Math.random());
        updateShader.setUniformBlock(gl, "FlowFieldUniforms", 0);
        updateShader.setFloat2(gl, "boundary", gl.canvas.width, gl.canvas.height);

        gl.enable(gl.RASTERIZER_DISCARD);
        gl.bindVertexArray(simulationVAO);
        gl.bindTransformFeedback(gl.TRANSFORM_FEEDBACK, tf!);

        gl.beginTransformFeedback(gl.POINTS);
        gl.drawArrays(gl.POINTS, 0, streamline);
        gl.endTransformFeedback();

        gl.bindVertexArray(null);
        gl.bindTransformFeedback(gl.TRANSFORM_FEEDBACK, null);
        gl.disable(gl.RASTERIZER_DISCARD);

        // Pass 1 - Operation 2: Update particle pool
        gl.bindBuffer(gl.TRANSFORM_FEEDBACK_BUFFER, xfLifeBuffer);
        gl.bindBuffer(gl.COPY_WRITE_BUFFER, lifeBuffer);
        gl.copyBufferSubData(gl.TRANSFORM_FEEDBACK_BUFFER, gl.COPY_WRITE_BUFFER, 0, 0, streamline * 1 * 4);

        gl.bindBuffer(gl.TRANSFORM_FEEDBACK_BUFFER, xfSimulationBuffer);
        gl.bindBuffer(gl.COPY_WRITE_BUFFER, simulationBuffer);
        gl.copyBufferSubData(gl.TRANSFORM_FEEDBACK_BUFFER, gl.COPY_WRITE_BUFFER, 0, 0, streamline * 3 * 4);
        gl.getBufferSubData(gl.TRANSFORM_FEEDBACK_BUFFER, 0, particleMapBuffer, 0, streamline * 3);
        gl.bindBuffer(gl.TRANSFORM_FEEDBACK_BUFFER, null);

        gl.bindTexture(gl.TEXTURE_2D, poolTextureBuffer);
        gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
        gl.texSubImage2D(gl.TEXTURE_2D, 0, textureOffsetArray[frameCount % MAX_SEGMENT_NUM].offsetX, textureOffsetArray[frameCount % MAX_SEGMENT_NUM].offsetY, maxBlockSize, maxBlockSize, gl.RGB, gl.FLOAT, particleMapBuffer);

        // Pass 2 - Operation 1: Rendering
        gl.viewport(0, 0, gl.canvas.width, gl.canvas.height);
        gl.enable(gl.BLEND);
        gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);

        gl.bindVertexArray(renderVAO);
        drawShader.use(gl);
        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, poolTextureBuffer);
        drawShader.setInt(gl, "particlePool", 0);
        drawShader.setInt(gl, "blockNum", MAX_SEGMENT_NUM);
        drawShader.setInt(gl, "beginBlock", frameCount % MAX_SEGMENT_NUM);
        drawShader.setInt(gl, "blockSize", maxBlockSize);
        drawShader.setFloat(gl, "fillWidth", ffController.fillWidth);
        drawShader.setFloat(gl, "aaWidth", ffController.aaWidth);
        drawShader.setFloat2(gl, "viewport", gl.canvas.width, gl.canvas.height);
        drawShader.setUniformBlock(gl, "FlowFieldUniforms", 0);
        gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, (segmentNum - 1) * 2, streamline);

        gl.disable(gl.BLEND);

        // Debug
        // Show particle pool
        if (ffController.content == "particle pool") {

            gl.enable(gl.BLEND);
            gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
            poolShader.use(gl);
            poolShader.setFloat2(gl, "viewport", window.innerWidth, window.innerHeight);
            poolShader.setInt(gl, "textureBuffer", 0);
            gl.activeTexture(gl.TEXTURE0);
            gl.bindTexture(gl.TEXTURE_2D, poolTextureBuffer);
            gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, 1);
            gl.disable(gl.BLEND);
        }
        if (ffController.content == "flow field") {

            textureShader.use(gl);
            gl.activeTexture(gl.TEXTURE0);
            gl.bindTexture(gl.TEXTURE_2D, ffTextureInfo[0]);
            gl.activeTexture(gl.TEXTURE1);
            gl.bindTexture(gl.TEXTURE_2D, ffTextureInfo[1]);
            textureShader.setInt(gl, "texture1", 0);
            textureShader.setInt(gl, "texture2", 1);
            textureShader.setFloat(gl, "progress", ffManager.getProgressBetweenTexture(frameCount));
            textureShader.setFloat2(gl, "viewport", window.innerWidth, window.innerHeight);
            gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, 1);
        }
        frameCount++;
    }

    let deltaTime = 0.0;
    let then = 0.0;
    function tickMain(now: number) {
        now *= 0.001;   // convert to seconds
        deltaTime = Math.min(now - then, 0.1);
        then = now;

        ffManager.tickLogic(deltaTime);
        tick(deltaTime);
        // gui.updateDisplay();
        stats.update();

        // Render loop
        requestAnimationFrame(tickMain);
    }

    requestAnimationFrame(tickMain);


}

onMounted(()=> {
    renderWay();
});