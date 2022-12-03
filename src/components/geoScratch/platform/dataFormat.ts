export enum ScratchDataFormat {
    UNKNOWN = 0,
    R8G8B8A8_UBYTE  = 1,
    R32G32B32_SFLOAT = 2
}

export interface DataFormat {
    internalFormat: number,
    format: number,
    type: number
}

export interface DataFormats {
    [formatName: number]: DataFormat
}