onmessage = function(e) {
    const aliveIndexArray = new Float32Array(e.data[0]);
    let aliveNum = 0;
    for (let i = 0; i < e.data[0]; i++) {
        if (e.data[2][i] < e.data[1]) {
            aliveIndexArray[aliveNum] = i;
            aliveNum += 1;
        }
    }

    this.postMessage([aliveNum, aliveIndexArray]);
}