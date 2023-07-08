<template>
    <div id="stats"></div>
    <div id="playground">
        <!-- <canvas ref="viewport" id="viewport"></canvas> -->
    </div>

</template>
    
<script setup lang='ts'>
    import { onMounted, ref } from 'vue';
    import { FlowFieldManager } from "./flowRenderElements/flowfield";
    import { FlowFieldController, type FlowFieldConstraints } from './geoScratch/function/framework/component/flowfieldController';
    import Stats from 'three/examples/jsm/libs/stats.module';
    import { GUI } from 'dat.gui'
    import { textureManager } from './geoScratch/core/managers';

    import { GetMap } from "./flowRenderElements/customLayer";
    import { FlowLayer } from "./flowRenderElements/flowLayer"
    import "mapbox-gl/dist/mapbox-gl.css";


    async function renderFlowInMap() {

        // Set FPS monitor
        const container = document.getElementById('stats'); 
        let stats = new (Stats as any)();
        container?.appendChild( stats.dom );

        // Initialize the flow field manager
        const ffManager = await FlowFieldManager.Create("http://localhost:5173/json/flow_field_description.json", stats);
    }

    onMounted(async()=> {
        await renderFlowInMap();

    });
</script>
    
<style>
#playground {
    height: 100%;
    width: 100%;
    margin: 0;
}

/* #viewport {
    top: 0;
    left: 0;
    width: 100%;
    height: 100%;
    display: block;
} */
</style>