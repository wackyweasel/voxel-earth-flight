// Per-aircraft flight models and handling numbers, in "scale 1" units (metres, seconds). flight.js reads every
// aerodynamic and handling constant from the active spec, main.js reads the sizing and camera fields.
//
// Lift acceleration is K V² CL, so the 1 g stall speed is sqrt(g / (K CLmax)) with CLmax = CL0 + CLA * stallAlpha.

export const AIRCRAFT = {
  light: {
    id: 'light',
    name: 'Sparrow',
    desc: 'Light prop plane',
    // aerodynamics
    CL0: 0.25, CLA: 5.2, stall: 0.3, stallNeg: 0.26, K: 0.0078,
    cd0: 1e-4, cdi: 1.2e-3, cFlat: 2.2e-3, cBrake: 2.2e-4, kSide: 0.004,
    // engine: static thrust acceleration, how it fades with speed, afterburner bonus, spool-up rate
    thrust: 7, thrustFade: 0.6, fadeV: 400, ab: 0, spool: 20, maxV: 700,
    trimSpeed: 90, trimThrottle: 0.42,
    // control response
    authority: [8, 45], pitchGain: 3.2, aUp: 0.3, aDown: 0.24,
    rollRate: 2.3, rollAssist: 1.7, bankLimit: 0.96, rudder: 0.7, holdGain: 0.9,
    gUp: 4, gDown: 1.5, aMinLimit: 0.2, assistV: [26, 40], noseOver: [40, 15],
    surfaceRate: [6, 6, 4], response: [9, 7, 5],
    // ground handling and landing limits
    steer: 0.75, steerFade: 25, rotate: 0.26, rolling: 0.03, brake: 0.5, hardSink: 5, crashSink: 12,
    // model, camera and effects
    gearDrop: 1.9, fx: 1, chase: [6, 22], eye: [1.4, -1.5], crashDist: 34, fov: 14,
    exitSide: 3.5, walkOff: 9, boardDist: 16, parkAhead: 14,
  },
  airliner: {
    id: 'airliner',
    name: 'Condor',
    desc: 'Twin-engine airliner',
    CL0: 0.2, CLA: 5.0, stall: 0.26, stallNeg: 0.2, K: 0.0017,
    cd0: 2.2e-5, cdi: 2.5e-4, cFlat: 4.8e-4, cBrake: 3.5e-5, kSide: 0.0012,
    thrust: 3.2, thrustFade: 0.5, fadeV: 500, ab: 0, spool: 0.55, maxV: 330,
    trimSpeed: 230, trimThrottle: 0.73,
    authority: [30, 90], pitchGain: 1.5, aUp: 0.22, aDown: 0.18,
    rollRate: 0.75, rollAssist: 0.6, bankLimit: 0.7, rudder: 0.18, holdGain: 0.4,
    gUp: 2.8, gDown: 0.5, aMinLimit: 0.12, assistV: [50, 70], noseOver: [74, 15],
    surfaceRate: [2.5, 2.5, 2], response: [4, 3.2, 2.5],
    steer: 0.3, steerFade: 40, rotate: 0.16, rolling: 0.02, brake: 0.3, hardSink: 3.5, crashSink: 9,
    gearDrop: 3.9, fx: 3, chase: [11, 62], eye: [0.9, -16.5], crashDist: 90, fov: 10,
    exitSide: 6, walkOff: 16, boardDist: 30, parkAhead: 40,
  },
  jet: {
    id: 'jet',
    name: 'Comet',
    desc: 'Very fast jet',
    CL0: 0.05, CLA: 3.5, stall: 0.5, stallNeg: 0.4, K: 0.0011,
    cd0: 5e-5, cdi: 2e-4, cFlat: 4e-4, cBrake: 6.4e-5, kSide: 0.0012,
    thrust: 16, thrustFade: 0.35, fadeV: 900, ab: 0.8, spool: 3, maxV: 800,
    trimSpeed: 320, trimThrottle: 0.6,
    authority: [15, 80], pitchGain: 4, aUp: 0.4, aDown: 0.3,
    rollRate: 4.5, rollAssist: 3.2, bankLimit: 1.35, rudder: 0.45, holdGain: 1.1,
    gUp: 9, gDown: 3, aMinLimit: 0.3, assistV: [60, 85], noseOver: [95, 20],
    surfaceRate: [9, 10, 6], response: [13, 12, 8],
    steer: 0.6, steerFade: 30, rotate: 0.3, rolling: 0.03, brake: 0.55, hardSink: 4.5, crashSink: 10,
    gearDrop: 2.1, fx: 1.6, chase: [4.5, 25], eye: [0.95, -3.8], crashDist: 50, fov: 18,
    exitSide: 3.5, walkOff: 10, boardDist: 20, parkAhead: 22,
  },
};

export const AIRCRAFT_IDS = Object.keys(AIRCRAFT);
