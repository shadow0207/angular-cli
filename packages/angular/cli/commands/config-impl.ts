/**
 * @license
 * Copyright Google Inc. All Rights Reserved.
 *
 * Use of this source code is governed by an MIT-style license that can be
 * found in the LICENSE file at https://angular.io/license
 */

import {
  InvalidJsonCharacterException,
  JsonArray,
  JsonObject,
  JsonParseMode,
  JsonValue,
  experimental,
  parseJson,
  tags,
} from '@angular-devkit/core';
import { writeFileSync } from 'fs';
import { Command } from '../models/command';
import { Arguments } from '../models/interface';
import {
  getWorkspace,
  getWorkspaceRaw,
  migrateLegacyGlobalConfig,
  validateWorkspace,
} from '../utilities/config';
import { Schema as ConfigCommandSchema, Value as ConfigCommandSchemaValue } from './config';


const validCliPaths = new Map([
  ['cli.warnings.versionMismatch', 'boolean'],
  ['cli.warnings.typescriptMismatch', 'boolean'],
  ['cli.defaultCollection', 'string'],
  ['cli.packageManager', 'string'],
]);

/**
 * Splits a JSON path string into fragments. Fragments can be used to get the value referenced
 * by the path. For example, a path of "a[3].foo.bar[2]" would give you a fragment array of
 * ["a", 3, "foo", "bar", 2].
 * @param path The JSON string to parse.
 * @returns {string[]} The fragments for the string.
 * @private
 */
function parseJsonPath(path: string): string[] {
  const fragments = (path || '').split(/\./g);
  const result: string[] = [];

  while (fragments.length > 0) {
    const fragment = fragments.shift();
    if (fragment == undefined) {
      break;
    }

    const match = fragment.match(/([^\[]+)((\[.*\])*)/);
    if (!match) {
      throw new Error('Invalid JSON path.');
    }

    result.push(match[1]);
    if (match[2]) {
      const indices = match[2].slice(1, -1).split('][');
      result.push(...indices);
    }
  }

  return result.filter(fragment => !!fragment);
}

function getValueFromPath<T extends JsonArray | JsonObject>(
  root: T,
  path: string,
): JsonValue | undefined {
  const fragments = parseJsonPath(path);

  try {
    return fragments.reduce((value: JsonValue, current: string | number) => {
      if (value == undefined || typeof value != 'object') {
        return undefined;
      } else if (typeof current == 'string' && !Array.isArray(value)) {
        return value[current];
      } else if (typeof current == 'number' && Array.isArray(value)) {
        return value[current];
      } else {
        return undefined;
      }
    }, root);
  } catch {
    return undefined;
  }
}

function setValueFromPath<T extends JsonArray | JsonObject>(
  root: T,
  path: string,
  newValue: JsonValue,
): JsonValue | undefined {
  const fragments = parseJsonPath(path);

  try {
    return fragments.reduce((value: JsonValue, current: string | number, index: number) => {
      if (value == undefined || typeof value != 'object') {
        return undefined;
      } else if (typeof current == 'string' && !Array.isArray(value)) {
        if (index === fragments.length - 1) {
          value[current] = newValue;
        } else if (value[current] == undefined) {
          if (typeof fragments[index + 1] == 'number') {
            value[current] = [];
          } else if (typeof fragments[index + 1] == 'string') {
            value[current] = {};
          }
        }

        return value[current];
      } else if (typeof current == 'number' && Array.isArray(value)) {
        if (index === fragments.length - 1) {
          value[current] = newValue;
        } else if (value[current] == undefined) {
          if (typeof fragments[index + 1] == 'number') {
            value[current] = [];
          } else if (typeof fragments[index + 1] == 'string') {
            value[current] = {};
          }
        }

        return value[current];
      } else {
        return undefined;
      }
    }, root);
  } catch {
    return undefined;
  }
}

function normalizeValue(value: ConfigCommandSchemaValue, path: string): JsonValue {
  const cliOptionType = validCliPaths.get(path);
  if (cliOptionType) {
    switch (cliOptionType) {
      case 'boolean':
        if (('' + value).trim() === 'true') {
          return true;
        } else if (('' + value).trim() === 'false') {
          return false;
        }
        break;
      case 'number':
        const numberValue = Number(value);
        if (!Number.isFinite(numberValue)) {
          return numberValue;
        }
        break;
      case 'string':
        return value;
    }

    throw new Error(`Invalid value type; expected a ${cliOptionType}.`);
  }

  if (typeof value === 'string') {
    try {
      return parseJson(value, JsonParseMode.Loose);
    } catch (e) {
      if (e instanceof InvalidJsonCharacterException && !value.startsWith('{')) {
        return value;
      } else {
        throw e;
      }
    }
  }

  return value;
}

export class ConfigCommand extends Command<ConfigCommandSchema> {
  public async run(options: ConfigCommandSchema & Arguments) {
    const level = options.global ? 'global' : 'local';

    let config =
      (getWorkspace(level) as {} as { _workspace: experimental.workspace.WorkspaceSchema });

    if (options.global && !config) {
      try {
        if (migrateLegacyGlobalConfig()) {
          config =
            (getWorkspace(level) as {} as { _workspace: experimental.workspace.WorkspaceSchema });
          this.logger.info(tags.oneLine`
            We found a global configuration that was used in Angular CLI 1.
            It has been automatically migrated.`);
        }
      } catch {}
    }

    if (options.value == undefined) {
      if (!config) {
        this.logger.error('No config found.');

        return 1;
      }

      return this.get(config._workspace, options);
    } else {
      return this.set(options);
    }
  }

  private get(config: experimental.workspace.WorkspaceSchema, options: ConfigCommandSchema) {
    let value;
    if (options.jsonPath) {
      value = getValueFromPath(config as {} as JsonObject, options.jsonPath);
    } else {
      value = config;
    }

    if (value === undefined) {
      this.logger.error('Value cannot be found.');

      return 1;
    } else if (typeof value == 'object') {
      this.logger.info(JSON.stringify(value, null, 2));
    } else {
      this.logger.info(value.toString());
    }

    return 0;
  }

  private set(options: ConfigCommandSchema) {
    if (!options.jsonPath || !options.jsonPath.trim()) {
      throw new Error('Invalid Path.');
    }
    if (options.global
        && !options.jsonPath.startsWith('schematics.')
        && !validCliPaths.has(options.jsonPath)) {
      throw new Error('Invalid Path.');
    }

    const [config, configPath] = getWorkspaceRaw(options.global ? 'global' : 'local');
    if (!config || !configPath) {
      this.logger.error('Confguration file cannot be found.');

      return 1;
    }

    // TODO: Modify & save without destroying comments
    const configValue = config.value;

    const value = normalizeValue(options.value || '', options.jsonPath);
    const result = setValueFromPath(configValue, options.jsonPath, value);

    if (result === undefined) {
      this.logger.error('Value cannot be found.');

      return 1;
    }

    try {
      validateWorkspace(configValue);
    } catch (error) {
      this.logger.fatal(error.message);

      return 1;
    }

    const output = JSON.stringify(configValue, null, 2);
    writeFileSync(configPath, output);

    return 0;
  }

}
