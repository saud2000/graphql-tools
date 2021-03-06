'use strict';

import * as lodash from 'lodash';
// eslint-disable-next-line
// @ts-ignore
import replaceall from 'replaceall';
// eslint-disable-next-line
// @ts-ignore
import * as BbPromise from 'bluebird';
import { Args } from './types/common';
import { Output, IOutput } from './Output';

export class Variables {
  json: any;
  overwriteSyntax = RegExp(/,/g);
  envRefSyntax = RegExp(/^env:/g);
  selfRefSyntax = RegExp(/^self:/g);
  stringRefSyntax = RegExp(/('.*')|(".*")/g);
  optRefSyntax = RegExp(/^opt:/g);
  variableSyntax = RegExp(
    // eslint-disable-next-line
    '\\${([ ~:a-zA-Z0-9._\'",\\-\\/\\(\\)]+?)}',
    'g'
  );

  fileName: string;
  options: Args;
  out: Output;
  envVars: any;

  constructor(fileName: string, options: Args = {}, out: IOutput = new Output(), envVars?: any) {
    this.out = out;
    this.fileName = fileName;
    this.options = options;
    this.envVars = envVars || process.env;
  }

  populateJson(json: any): Promise<any> {
    this.json = json;
    return this.populateObject(this.json).then(() => {
      return BbPromise.resolve(this.json);
    });
  }

  public populateObject(objectToPopulate: any) {
    const populateAll: any[] = [];
    const deepMapValues = (object: any, callback: any, propertyPath?: string[]): any => {
      const deepMapValuesIteratee = (value: any, key: any) =>
        deepMapValues(value, callback, propertyPath ? propertyPath.concat(key) : [key]);
      if (lodash.isArray(object)) {
        return lodash.map(object, deepMapValuesIteratee);
      } else if (
        lodash.isObject(object) &&
        !lodash.isDate(object) &&
        !lodash.isRegExp(object) &&
        !lodash.isFunction(object)
      ) {
        return lodash.extend({}, object, lodash.mapValues(object, deepMapValuesIteratee));
      }
      return callback(object, propertyPath);
    };

    deepMapValues(objectToPopulate, (property: any, propertyPath: any) => {
      if (typeof property === 'string') {
        const populateSingleProperty = this.populateProperty(property, true)
          .then((newProperty: any) => lodash.set(objectToPopulate, propertyPath, newProperty))
          .return();
        populateAll.push(populateSingleProperty);
      }
    });

    return BbPromise.all(populateAll).then(() => objectToPopulate);
  }

  populateProperty(propertyParam: any, populateInPlace?: boolean) {
    let property = populateInPlace ? propertyParam : lodash.cloneDeep(propertyParam);
    const allValuesToPopulate: any[] = [];
    let warned = false;

    if (typeof property === 'string' && property.match(this.variableSyntax)) {
      property.match(this.variableSyntax)!.forEach(matchedString => {
        const variableString = matchedString
          .replace(this.variableSyntax, (_, varName) => varName.trim())
          .replace(/\s/g, '');

        let singleValueToPopulate: Promise<any> | null = null;
        if (variableString.match(this.overwriteSyntax)) {
          singleValueToPopulate = this.overwrite(variableString);
        } else {
          singleValueToPopulate = this.getValueFromSource(variableString).then((valueToPopulate: any) => {
            if (typeof valueToPopulate === 'object') {
              return this.populateObject(valueToPopulate);
            }
            return valueToPopulate;
          });
        }

        singleValueToPopulate = singleValueToPopulate!.then(valueToPopulate => {
          if (this.warnIfNotFound(variableString, valueToPopulate)) {
            warned = true;
          }
          return this.populateVariable(property, matchedString, valueToPopulate).then((newProperty: any) => {
            property = newProperty;
            return BbPromise.resolve(property);
          });
        });

        allValuesToPopulate.push(singleValueToPopulate);
      });
      return BbPromise.all(allValuesToPopulate).then(() => {
        if ((property as any) !== (this.json as any) && !warned) {
          return this.populateProperty(property);
        }
        return BbPromise.resolve(property);
      });
    }
    return BbPromise.resolve(property);
  }

  populateVariable(propertyParam: any, matchedString: any, valueToPopulate: any) {
    let property = propertyParam;
    if (typeof valueToPopulate === 'string') {
      property = replaceall(matchedString, valueToPopulate, property);
    } else {
      if (property !== matchedString) {
        if (typeof valueToPopulate === 'number') {
          property = replaceall(matchedString, String(valueToPopulate), property);
        } else {
          const errorMessage = [
            'Trying to populate non string value into',
            ` a string for variable ${matchedString}.`,
            ' Please make sure the value of the property is a string.',
          ].join('');
          this.out.warn(this.out.getErrorPrefix(this.fileName, 'warning') + errorMessage);
        }
        return BbPromise.resolve(property);
      }
      property = valueToPopulate;
    }
    return BbPromise.resolve(property);
  }

  overwrite(variableStringsString: any) {
    let finalValue: any;
    const variableStringsArray = variableStringsString.split(',');
    const allValuesFromSource = variableStringsArray.map((variableString: any) =>
      this.getValueFromSource(variableString)
    );
    return BbPromise.all(allValuesFromSource).then((valuesFromSources: any) => {
      valuesFromSources.find((valueFromSource: any) => {
        finalValue = valueFromSource;
        return (
          finalValue !== null &&
          typeof finalValue !== 'undefined' &&
          !(typeof finalValue === 'object' && lodash.isEmpty(finalValue))
        );
      });
      return BbPromise.resolve(finalValue);
    });
  }

  getValueFromSource(variableString: any) {
    if (variableString.match(this.envRefSyntax)) {
      return this.getValueFromEnv(variableString);
    } else if (variableString.match(this.optRefSyntax)) {
      return this.getValueFromOptions(variableString);
    } else if (variableString.match(this.selfRefSyntax)) {
      return this.getValueFromSelf(variableString);
    } else if (variableString.match(this.stringRefSyntax)) {
      return this.getValueFromString(variableString);
    }
    const errorMessage = [
      `Invalid variable reference syntax for variable ${variableString}.`,
      ' You can only reference env vars, options, & files.',
      ' You can check our docs for more info.',
    ].join('');
    this.out.warn(this.out.getErrorPrefix(this.fileName, 'warning') + errorMessage);
  }

  getValueFromEnv(variableString: any) {
    const requestedEnvVar = variableString.split(':')[1];
    const valueToPopulate = requestedEnvVar !== '' || '' in this.envVars ? this.envVars[requestedEnvVar] : this.envVars;
    return BbPromise.resolve(valueToPopulate);
  }

  getValueFromString(variableString: any) {
    const valueToPopulate = variableString.replace(/^['"]|['"]$/g, '');
    return BbPromise.resolve(valueToPopulate);
  }

  getValueFromOptions(variableString: any) {
    const requestedOption = variableString.split(':')[1];
    const valueToPopulate = requestedOption !== '' || '' in this.options ? this.options[requestedOption] : this.options;
    return BbPromise.resolve(valueToPopulate);
  }

  getValueFromSelf(variableString: any) {
    const valueToPopulate = this.json;
    const deepProperties = variableString.split(':')[1].split('.');
    return this.getDeepValue(deepProperties, valueToPopulate);
  }

  getDeepValue(deepProperties: any, valueToPopulate: any) {
    return BbPromise.reduce(
      deepProperties,
      (computedValueToPopulateParam: any, subProperty: any) => {
        let computedValueToPopulate = computedValueToPopulateParam;
        if (typeof computedValueToPopulate === 'undefined') {
          computedValueToPopulate = {};
        } else if (subProperty !== '' || '' in computedValueToPopulate) {
          computedValueToPopulate = computedValueToPopulate[subProperty];
        }
        if (typeof computedValueToPopulate === 'string' && computedValueToPopulate.match(this.variableSyntax)) {
          return this.populateProperty(computedValueToPopulate);
        }
        return BbPromise.resolve(computedValueToPopulate);
      },
      valueToPopulate
    );
  }

  warnIfNotFound(variableString: any, valueToPopulate: any): boolean {
    if (
      valueToPopulate === null ||
      typeof valueToPopulate === 'undefined' ||
      (typeof valueToPopulate === 'object' && lodash.isEmpty(valueToPopulate))
    ) {
      let varType;
      if (variableString.match(this.envRefSyntax)) {
        varType = 'environment variable';
      } else if (variableString.match(this.optRefSyntax)) {
        varType = 'option';
      } else if (variableString.match(this.selfRefSyntax)) {
        varType = 'self reference';
      }
      this.out.warn(
        this.out.getErrorPrefix(this.fileName, 'warning') +
          `A valid ${varType} to satisfy the declaration '${variableString}' could not be found.`
      );
      return true;
    }

    return false;
  }
}
