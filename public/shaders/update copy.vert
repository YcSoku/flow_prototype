#version 300 es
precision highp float;

layout (location=0) in vec3 particleInfo;
layout (location=1) in float age;

layout (std140) uniform FlowFieldUniforms
{
    float progress;
    float segmentNum;
    float fullLife;
    float dropRate;
    float dropRateBump;
    float speedFactor;
    vec4 flowBoundary; // vec4(uMin, vMin, uMax, vMax)
    
};

uniform sampler2D flowField[2];
uniform sampler2D mask[2];
uniform sampler2D validAddress;
uniform vec2 boundary;
uniform float randomSeed;

out vec3 newInfo;
out float aliveTime;

// pseudo-random generator
float rand(const vec2 co) {
    const vec3 rand_constants = vec3(12.9898, 78.233, 4375.85453);
    float t = dot(rand_constants.xy, co);
    return abs(fract(sin(t) * (rand_constants.z + t)));
}

float drop(float velocity, vec2 uv)
{
    vec2 seed = (particleInfo.xy + uv) * randomSeed;
    float drop_rate = dropRate - velocity * dropRateBump;
    return step(drop_rate, rand(seed));
}

vec2 get_speed(sampler2D sFlowField, sampler2D sMask, vec2 uv, vec2 resolution)
{
    ivec2 texcoords = ivec2(uv * resolution);
    vec2 f = fract(uv * resolution);
    vec2 signal = sign(f - vec2(0.5));

    vec2 speed_tl = texelFetch(sFlowField, texcoords, 0).rg;
    vec2 speed_tr, speed_bl, speed_br;

    vec4 color_tr = texelFetch(sMask, texcoords + ivec2(signal.x, 0), 0);
    vec4 color_bl = texelFetch(sMask, texcoords + ivec2(0, signal.y), 0);
    vec4 color_br = texelFetch(sMask, texcoords + ivec2(signal.x, signal.y), 0);

    if (color_tr.a * color_bl.a * color_br.a == 0.0)
    {
        speed_tr = speed_bl = speed_br = speed_tl;
    }
    else 
    {
        speed_tr = texelFetch(sFlowField, texcoords + ivec2(signal.x, 0), 0).rg;
        speed_bl = texelFetch(sFlowField, texcoords + ivec2(0, signal.y), 0).rg;
        speed_br = texelFetch(sFlowField, texcoords + ivec2(signal.x, signal.y), 0).rg;
    }

    return mix(mix(speed_tl, speed_tr, f.x), mix(speed_bl, speed_br, f.x), f.y);
}

vec2 lookup_speed(vec2 uv, vec2 resolution)
{
    vec2 lSpeed = get_speed(flowField[0], mask[0],uv, resolution);
    vec2 nSpeed = get_speed(flowField[1], mask[1],uv, resolution);
    vec2 speed = mix(lSpeed, nSpeed, progress);
    return mix(flowBoundary.xy, flowBoundary.zw, speed);
}

float is_in_flow(vec2 uv)
{
    return step(0.0, 2.0 * mix(texture(mask[0], uv).r, texture(mask[1], uv).r, progress) - 1.0);
}

float speed_rate(vec2 speed)
{
    return length(speed) / length(flowBoundary.zw);
}

void die(vec2 resolution)
{
    vec2 seed = randomSeed + particleInfo.xy;

    vec2 uv = vec2(rand(seed + 1.3), rand(seed + 2.1));
    vec4 rebirthColor = texture(validAddress, uv);
    float rebirth_x = float((int(rebirthColor.r * 255.0) << 8) + int(rebirthColor.g * 255.0));
    float rebirth_y = float((int(rebirthColor.b * 255.0) << 8) + int(rebirthColor.a * 255.0));
    rebirth_x = rebirth_x + rand(seed + rebirth_x);
    rebirth_y = rebirth_y + rand(seed + rebirth_y);

    vec2 rebirthPos = vec2(rebirth_x, rebirth_y) / resolution;
    newInfo = vec3(rebirthPos, speed_rate(lookup_speed(rebirthPos, resolution)));
    aliveTime = age + 1.0;
    
}

void freeze()
{
    newInfo = particleInfo;
    aliveTime = age + 1.0;
}

void rebirth()
{
    newInfo = particleInfo;
    aliveTime = 0.0;
}

void simulation(vec2 resolution)
{
    vec2 uv = particleInfo.xy;
    vec2 speed = lookup_speed(uv, resolution);
    float speedRate = speed_rate(speed);

    vec2 nPos = vec2(particleInfo.xy + speed * speedFactor / boundary);
    nPos = clamp(nPos, vec2(0.0), vec2(1.0));
    float dropped = drop(speedRate, uv) * is_in_flow(nPos);

    newInfo = mix(particleInfo, vec3(nPos, speedRate), dropped);
    aliveTime = mix(fullLife - segmentNum, age + 1.0, dropped);
}

void main()
{
    vec2 resolution = vec2(textureSize(mask[1], 0));
    
    if (age < fullLife - segmentNum)
    {
        simulation(resolution);
    }
    else if (age == fullLife)
    {
        die(resolution);
    }
    else if (abs(fullLife - age) <= segmentNum)
    {
        freeze();
    }
    else
    {
        rebirth();
    }
}