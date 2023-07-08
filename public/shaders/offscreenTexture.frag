#version 300 es
precision highp float;

uniform sampler2D ofsTexture;

in vec2 texcoords;

out vec4 fragColor;

void main() 
{
    fragColor = texture(ofsTexture, texcoords);
}