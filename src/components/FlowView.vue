<template>
    <div id="stats"></div>
    <div id="playground">
        <canvas ref="viewport" id="viewport"></canvas>
    </div>
</template>
    
<script setup lang='ts'>
    import {onMounted, ref} from 'vue';
    import {FlowFieldManager} from "./geoScratch/function/framework/component/mesh/flowfield"
    import Stats from 'three/examples/jsm/libs/stats.module';
    import {GUI} from 'dat.gui'
    import { textureManager } from './geoScratch/core/managers';

    const viewport = ref<HTMLCanvasElement>();

    const renderWay = async() => {
        // Get WebGL2 Context
        const gl = viewport.value!.getContext("webgl2", {antialias: true})!;
        gl.canvas.width = window.innerWidth * window.devicePixelRatio;
        gl.canvas.height = window.innerHeight * window.devicePixelRatio;
        const available_extensions = gl.getSupportedExtensions()!;
        for (const extension of available_extensions)
        {
            gl.getExtension(extension);
        }

        textureManager.SetContext(gl);

        // Set FPS monitor
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

        // Initialize the GUI
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

        // Ready to rendering
        let deltaTime = 0.0;
        let then = 0.0;
        function tickMain(now: number) {
            // Render loop
            requestAnimationFrame(tickMain);
            
            now *= 0.001;   // convert to seconds
            deltaTime = Math.min(now - then, 0.1);
            then = now;

            ffManager.tickLogic(deltaTime);
            ffManager.tickRender(gl, deltaTime);
            // gui.updateDisplay();
            stats.update();
        }
        requestAnimationFrame(tickMain);
    }

    onMounted(()=> {
        renderWay();
    });
</script>
    
<style>
#playground {
    height: 100%;
    width: 100%;
    margin: 0;
}

#viewport {
    top: 0;
    left: 0;
    width: 100%;
    height: 100%;
    display: block;
}
</style>