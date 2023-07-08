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

// Denormalize 8-bit color channels to integers in the range 0 to 255.
ivec4 floatsToBytes(vec4 inputFloats, bool littleEndian) {
  ivec4 bytes = ivec4(inputFloats * 255.0);
  return (
    littleEndian
    ? bytes.abgr
    : bytes
  );
}

// Break the four bytes down into an array of 32 bits.
void bytesToBits(const in ivec4 bytes, out bool bits[32]) {
  for (int channelIndex = 0; channelIndex < 4; ++channelIndex) {
    float acc = float(bytes[channelIndex]);
    for (int indexInByte = 7; indexInByte >= 0; --indexInByte) {
      float powerOfTwo = exp2(float(indexInByte));
      bool bit = acc >= powerOfTwo;
      bits[channelIndex * 8 + (7 - indexInByte)] = bit;
      acc = mod(acc, powerOfTwo);
    }
  }
}

// Compute the exponent of the 32-bit float.
float getExponent(bool bits[32]) {
  const int startIndex = 1;
  const int bitStringLength = 8;
  const int endBeforeIndex = startIndex + bitStringLength;
  float acc = 0.0;
  int pow2 = bitStringLength - 1;
  for (int bitIndex = startIndex; bitIndex < endBeforeIndex; ++bitIndex) {
    acc += float(bits[bitIndex]) * exp2(float(pow2--));
  }
  return acc;
}

// Compute the mantissa of the 32-bit float.
float getMantissa(bool bits[32], bool subnormal) {
  const int startIndex = 9;
  const int bitStringLength = 23;
  const int endBeforeIndex = startIndex + bitStringLength;
  // Leading/implicit/hidden bit convention:
  // If the number is not subnormal (with exponent 0), we add a leading 1 digit.
  float acc = float(!subnormal) * exp2(float(bitStringLength));
  int pow2 = bitStringLength - 1;
  for (int bitIndex = startIndex; bitIndex < endBeforeIndex; ++bitIndex) {
    acc += float(bits[bitIndex]) * exp2(float(pow2--));
  }
  return acc;
}

// Parse the float from its 32 bits.
float bitsToFloat(bool bits[32]) {
  float signBit = float(bits[0]) * -2.0 + 1.0;
  float exponent = getExponent(bits);
  bool subnormal = abs(exponent - 0.0) < 0.01;
  float mantissa = getMantissa(bits, subnormal);
  float exponentBias = 127.0;
  return signBit * mantissa * exp2(exponent - exponentBias - 23.0);
}

// Decode a 32-bit float from the RGBA color channels of a texel.
float rgbaToFloat(vec4 texelRGBA, bool littleEndian) {
  ivec4 rgbaBytes = floatsToBytes(texelRGBA, littleEndian);
  bool bits[32];
  bytesToBits(rgbaBytes, bits);
  return bitsToFloat(bits);
}

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

vec2 decode_speed_from_(vec4 color)
{
    return vec2(color.r + color.g / 255.0, color.b + color.a / 255.0);
}

vec2 get_speed(sampler2D sFlowField, sampler2D sMask, vec2 uv, vec2 resolution)
{
    ivec2 texcoords = ivec2(uv * resolution);
    vec2 f = fract(uv * resolution);
    vec2 signal = sign(f - vec2(0.5));

    vec4 color_tl = texelFetch(sFlowField, texcoords, 0);
    vec4 color_tr = texelFetch(sMask, texcoords + ivec2(signal.x, 0), 0);
    vec4 color_bl = texelFetch(sMask, texcoords + ivec2(0, signal.y), 0);
    vec4 color_br = texelFetch(sMask, texcoords + ivec2(signal.x, signal.y), 0);

    if (color_tr.a * color_bl.a * color_br.a == 0.0)
    {
        color_tr = color_bl = color_br = color_tl;
    }
    else 
    {
        color_tr = texelFetch(sFlowField, texcoords + ivec2(signal.x, 0), 0);
        color_bl = texelFetch(sFlowField, texcoords + ivec2(0, signal.y), 0);
        color_br = texelFetch(sFlowField, texcoords + ivec2(signal.x, signal.y), 0);
    }

    vec2 speed_tl = decode_speed_from_(color_tl);
    vec2 speed_tr = decode_speed_from_(color_tr);
    vec2 speed_bl = decode_speed_from_(color_bl);
    vec2 speed_br = decode_speed_from_(color_br);

    return mix(mix(speed_tl, speed_tr, f.x), mix(speed_bl, speed_br, f.x), f.y);
}



// float is_in_flow(sampler2D sMask, ivec2 texcoords)
// {
//     vec4 color = texelFetch(sMask, texcoords, 0);

//     ivec2 xy = ivec2((int(color.r * 255.0) << 8) + int(color.g * 255.0), (int(color.b * 255.0) << 8) + int(color.a * 255.0));
//     if (xy == texcoords) return 1.0;
//     return 0.0;
// }
// vec2 get_speed(sampler2D sFlowField, sampler2D sMask, vec2 uv, vec2 resolution)
// {
//     ivec2 texcoords = ivec2(uv * resolution);
//     vec2 f = fract(uv * resolution);
//     vec2 signal = sign(f - vec2(0.5));

//     vec2 speed_tl = texelFetch(sFlowField, texcoords, 0).rg;
//     vec2 speed_tr, speed_bl, speed_br;

//     float out_tr = is_in_flow(sMask, texcoords + ivec2(signal.x, 0));
//     float out_bl = is_in_flow(sMask, texcoords + ivec2(0, signal.y));
//     float out_br = is_in_flow(sMask, texcoords + ivec2(signal.x, signal.y));

//     if (out_tr * out_bl * out_br == 0.0)
//     {
//         speed_tr = speed_bl = speed_br = speed_tl;
//     }
//     else 
//     {
//         speed_tr = texelFetch(sFlowField, texcoords + ivec2(signal.x, 0), 0).rg;
//         speed_bl = texelFetch(sFlowField, texcoords + ivec2(0, signal.y), 0).rg;
//         speed_br = texelFetch(sFlowField, texcoords + ivec2(signal.x, signal.y), 0).rg;
//     }

//     return mix(mix(speed_tl, speed_tr, f.x), mix(speed_bl, speed_br, f.x), f.y);
// }

vec2 get_speed2(sampler2D sFlowField, sampler2D sMask, vec2 uv, vec2 resolution)
{
    ivec2 texcoords = ivec2(uv * resolution);
    vec2 speed_tl = texelFetch(sFlowField, texcoords, 0).rg;

    return speed_tl;
}

vec2 lookup_speed(vec2 uv, vec2 resolution)
{
    vec2 lSpeed = get_speed2(flowField[0], mask[0],uv, resolution);
    vec2 nSpeed = get_speed2(flowField[1], mask[1],uv, resolution);
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
    // rebirthColor.rgba = pow(rebirthColor.rgba, vec4(1.0 / 2.2));
    // rebirthColor.rgb = rebirthColor.rgb / rebirthColor.a;
    float rebirth_x = float((int(rebirthColor.r * 255.0) << 8) + int(rebirthColor.g * 255.0));
    float rebirth_y = float((int(rebirthColor.b * 255.0) << 8) + int(rebirthColor.a * 255.0));
    rebirth_x = rebirth_x + rand(seed + rebirth_x);
    rebirth_y = rebirth_y + rand(seed + rebirth_y);

    vec2 rebirthPos = vec2(rebirth_x, rebirth_y) / resolution;
    // rebirthPos = uv;
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