#version 300 es
precision highp float;

in struct Stream_line_setting 
{
    float edgeParam;
    float alphaDegree;
    float isDiscarded;
    float velocity; // a percentage
} sls;

uniform float fillWidth;
uniform float aaWidth;

out vec4 fragColor;

int rampColors[8] = int[](
    0x3288bd,
    0x66c2a5,
    0xabdda4,
    0xe6f598,
    0xfee08b,
    0xfdae61,
    0xf46d43,
    0xd53e4f
);

vec3 colorFromInt(int color)
{
    float b = float(color & 0xFF) / 255.0;
    float g = float((color >> 8) & 0xFF) / 255.0;
    float r = float((color >> 16) & 0xFF) / 255.0;

    return vec3(r, g, b);
}

vec3 velocityColor(float speed)
{
    float bottomIndex = floor(speed * 10.0);
    float topIndex = mix(bottomIndex + 1.0, 7.0, step(6.0, bottomIndex));
    float interval = mix(1.0, 4.0, step(6.0, bottomIndex));

    vec3 slowColor = colorFromInt(rampColors[int(bottomIndex)]);
    vec3 fastColor = colorFromInt(rampColors[int(topIndex)]);

    return mix(slowColor, fastColor, (speed * 10.0 - float(bottomIndex)) / interval);
}

float getAlpha(float param)
{
    if (aaWidth == 0.0) return 1.0;
    float alpha = 1.0 - sin(clamp((param * (0.5 * fillWidth + aaWidth) - 0.5 * fillWidth) / aaWidth, 0.0, 1.0) * 2.0 / 3.141592653);
    return alpha;
}

void main() 
{
    if (sls.isDiscarded <= 0.0) discard;
    float alpha = getAlpha(abs(sls.edgeParam));

    // vec3 color = mix(colorFromInt(rampColors[int(sls.velocity * 7.0)]), colorFromInt(rampColors[int(sls.velocity * 7.0 + 0.5)]), fract(sls.velocity * 7.0));
    vec3 color = velocityColor(sls.velocity);
    color = mix(vec3(0.6), color, alpha);
    fragColor = vec4(color, 1.0);
}