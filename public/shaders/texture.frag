#version 300 es
precision highp float;

uniform sampler2D texture1;
uniform sampler2D texture2;
uniform float progress;
uniform vec2 viewport;

in vec2 texcoords;

out vec4 fragColor;

void main() 
{
    // vec3 color = mix(texture(texture1, texcoords), texture(texture2, texcoords), progress).rgb;
    // fragColor = vec4(color, 1.0);
    // vec2 colorf = mix(texture(texture1, texcoords), texture(texture2, texcoords), progress).rg;
    // fragColor = vec4(colorf, 0.0, 1.0);
    vec4 color4i = mix(texture(texture1, texcoords), texture(texture2, texcoords), progress).rgba;
    fragColor = color4i;
}