import {
  assertExactKeys,
  COMMAND_SURFACE_VALUES,
  SUPPORTED_COMMAND_KEYS,
} from "./mode-registry-schema.mjs";

const COMMAND_PATTERN = /^[a-z][a-z0-9-]{0,31}$/;
const RESERVED_COMMAND_NAMES = new Set([
  "__proto__",
  "constructor",
  "prototype",
  "toString",
  "valueOf",
  "hasOwnProperty",
  "isPrototypeOf",
  "propertyIsEnumerable",
  "toLocaleString",
]);

export function validateCommandRoutes(routes, modeId, commandSurfaces) {
  if (!Array.isArray(routes)) {
    throw new TypeError(`Mode ${modeId} has invalid command routing.`);
  }
  const routeKeys = Object.keys(routes);
  if (
    routeKeys.length !== routes.length ||
    routeKeys.some((key, index) => key !== String(index))
  ) {
    throw new TypeError(`Mode ${modeId} has invalid command routing.`);
  }
  for (const route of routes) {
    assertExactKeys(
      route,
      SUPPORTED_COMMAND_KEYS,
      `Mode ${modeId} command route`,
    );
    if (
      typeof route.command !== "string" ||
      !COMMAND_PATTERN.test(route.command)
    ) {
      throw new TypeError(`Mode ${modeId} has invalid command routing.`);
    }
    if (RESERVED_COMMAND_NAMES.has(route.command)) {
      throw new TypeError(`Mode ${modeId} uses a reserved command name.`);
    }
    if (
      !Array.isArray(route.surfaces) ||
      route.surfaces.length === 0 ||
      route.surfaces.some((surface) => !COMMAND_SURFACE_VALUES.has(surface)) ||
      new Set(route.surfaces).size !== route.surfaces.length
    ) {
      throw new TypeError(`Mode ${modeId} has invalid command routing.`);
    }
    for (const surface of route.surfaces) {
      const key = `${route.command}:${surface}`;
      if (commandSurfaces.has(key)) {
        throw new TypeError(
          `Mode registry contains duplicate command routing: ${route.command} on ${surface}`,
        );
      }
      commandSurfaces.add(key);
    }
  }
}

export function buildCommandModeLookup(modes) {
  const lookup = Object.create(null);
  for (const mode of modes) {
    for (const route of mode.supportedCommands) {
      if (!Object.hasOwn(lookup, route.command)) {
        lookup[route.command] = Object.create(null);
      }
      for (const surface of route.surfaces) {
        lookup[route.command][surface] = mode.id;
      }
    }
  }
  return lookup;
}
