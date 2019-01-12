/**
 * @license
 * Copyright Google Inc. All Rights Reserved.
 *
 * Use of this source code is governed by an MIT-style license that can be
 * found in the LICENSE file at https://angular.io/license
 */

import {
  BuildEvent,
  Builder,
  BuilderConfiguration,
  BuilderContext,
} from '@angular-devkit/architect';
import { Path, getSystemPath, normalize, resolve, virtualFs } from '@angular-devkit/core';
import * as fs from 'fs';
import * as glob from 'glob';
import { Observable, of } from 'rxjs';
import { concatMap } from 'rxjs/operators';
import * as ts from 'typescript'; // tslint:disable-line:no-implicit-dependencies
import { WebpackConfigOptions } from '../angular-cli-files/models/build-options';
import {
  getCommonConfig,
  getNonAotTestConfig,
  getStylesConfig,
  getTestConfig,
} from '../angular-cli-files/models/webpack-configs';
import { readTsconfig } from '../angular-cli-files/utilities/read-tsconfig';
import { requireProjectModule } from '../angular-cli-files/utilities/require-project-module';
import { defaultProgress, normalizeBuilderSchema } from '../utils';
import { KarmaBuilderSchema, NormalizedKarmaBuilderSchema } from './schema';
const webpackMerge = require('webpack-merge');


export class KarmaBuilder implements Builder<KarmaBuilderSchema> {
  constructor(public context: BuilderContext) { }

  run(builderConfig: BuilderConfiguration<KarmaBuilderSchema>): Observable<BuildEvent> {
    const root = this.context.workspace.root;
    const projectRoot = resolve(root, builderConfig.root);
    const host = new virtualFs.AliasHost(this.context.host as virtualFs.Host<fs.Stats>);

    const options = normalizeBuilderSchema(
      host,
      root,
      builderConfig,
    );

    return of(null).pipe(
      concatMap(() => new Observable(obs => {
        const karma = requireProjectModule(getSystemPath(projectRoot), 'karma');
        const karmaConfig = getSystemPath(resolve(root, normalize(options.karmaConfig)));

        // TODO: adjust options to account for not passing them blindly to karma.
        // const karmaOptions: any = Object.assign({}, options);
        // tslint:disable-next-line:no-any
        const karmaOptions: any = {};

        if (options.watch !== undefined) {
          karmaOptions.singleRun = !options.watch;
        }

        // Convert browsers from a string to an array
        if (options.browsers) {
          karmaOptions.browsers = options.browsers.split(',');
        }

        if (options.reporters) {
          // Split along commas to make it more natural, and remove empty strings.
          const reporters = options.reporters
            .reduce<string[]>((acc, curr) => acc.concat(curr.split(/,/)), [])
            .filter(x => !!x);

          if (reporters.length > 0) {
            karmaOptions.reporters = reporters;
          }
        }

        const sourceRoot = builderConfig.sourceRoot && resolve(root, builderConfig.sourceRoot);
        const webpackConfig = this.buildWebpackConfig(root, projectRoot, sourceRoot, host, options);

        // generate new entry point with files matching provided glob
        if (options.spec) {
          const mainEntry = webpackConfig.entry.main;
          const newMainEntry = webpackConfig.entry.main.replace(/\.ts$/, '.generated.ts');
          // replace original entry with generated one
          webpackConfig.entry.main = newMainEntry;

          try {
            this.createOrUpdateGeneratedTestFile(
              options.spec,
              getSystemPath(sourceRoot || projectRoot),
              builderConfig.sourceRoot,
              mainEntry,
              newMainEntry,
            );

            // early exit if we are only supposed to update generated file
            if (options.specUpdate) {
              obs.next({ success: true, result: 'specs updated' });
              obs.complete();

              return;
            }
          } catch (err) {
            this.context.logger.error(err.message);
            obs.next({ success: false });
            obs.complete();

            return;
          }
        }

        karmaOptions.buildWebpack = {
          root: getSystemPath(root),
          projectRoot: getSystemPath(projectRoot),
          options,
          webpackConfig,
          // Pass onto Karma to emit BuildEvents.
          successCb: () => obs.next({ success: true }),
          failureCb: () => obs.next({ success: false }),
          // Workaround for https://github.com/karma-runner/karma/issues/3154
          // When this workaround is removed, user projects need to be updated to use a Karma
          // version that has a fix for this issue.
          toJSON: () => { },
          logger: this.context.logger,
        };

        // TODO: inside the configs, always use the project root and not the workspace root.
        // Until then we pretend the app root is relative (``) but the same as `projectRoot`.
        karmaOptions.buildWebpack.options.root = '';

        // Assign additional karmaConfig options to the local ngapp config
        karmaOptions.configFile = karmaConfig;

        // Complete the observable once the Karma server returns.
        const karmaServer = new karma.Server(karmaOptions, () => obs.complete());
        const karmaStartPromise = karmaServer.start();

        // Cleanup, signal Karma to exit.
        return () => {
          // Karma only has the `stop` method start with 3.1.1, so we must defensively check.
          if (karmaServer.stop && typeof karmaServer.stop === 'function') {
            return karmaStartPromise.then(() => karmaServer.stop());
          }
        };
      })),
    );
  }

  buildWebpackConfig(
    root: Path,
    projectRoot: Path,
    sourceRoot: Path | undefined,
    host: virtualFs.Host<fs.Stats>,
    options: NormalizedKarmaBuilderSchema,
  ) {
    let wco: WebpackConfigOptions;

    const tsConfigPath = getSystemPath(resolve(root, normalize(options.tsConfig)));
    const tsConfig = readTsconfig(tsConfigPath);

    const projectTs = requireProjectModule(getSystemPath(projectRoot), 'typescript') as typeof ts;

    const supportES2015 = tsConfig.options.target !== projectTs.ScriptTarget.ES3
      && tsConfig.options.target !== projectTs.ScriptTarget.ES5;

    const compatOptions: typeof wco['buildOptions'] = {
      ...options as {} as typeof wco['buildOptions'],
      // Some asset logic inside getCommonConfig needs outputPath to be set.
      outputPath: '',
    };

    wco = {
      root: getSystemPath(root),
      logger: this.context.logger,
      projectRoot: getSystemPath(projectRoot),
      sourceRoot: sourceRoot && getSystemPath(sourceRoot),
      // TODO: use only this.options, it contains all flags and configs items already.
      buildOptions: compatOptions,
      tsConfig,
      tsConfigPath,
      supportES2015,
    };

    wco.buildOptions.progress = defaultProgress(wco.buildOptions.progress);

    const webpackConfigs: {}[] = [
      getCommonConfig(wco),
      getStylesConfig(wco),
      getNonAotTestConfig(wco, host),
      getTestConfig(wco),
    ];

    return webpackMerge(webpackConfigs);
  }

  createOrUpdateGeneratedTestFile(
    pattern: string,
    path: string,
    sourceRoot: Path | undefined,
    mainEntry: string,
    newMainEntry: string,
  ) {
    let template = fs.readFileSync(mainEntry).toString();
    // remove source root to support absolute paths
    if (sourceRoot && pattern.startsWith(sourceRoot + '/')) {
      pattern = pattern.substr(sourceRoot.length + 1); // +1 to include slash
    }
    if (pattern.endsWith('.ts') && pattern.indexOf('.spec.ts') === -1) {
      pattern = pattern.substr(0, pattern.length - 2) + 'spec.ts';
    } else if (pattern.indexOf('.spec') === -1) {
      pattern += '.spec.ts';
    }

    const files = glob.sync(pattern, { cwd: path });
    if (!files.length) {
      throw new Error('Specified spec glob does not match any files');
    }

    const start = 'import \'';
    const end = '\';';
    const testCode = start + files
      .map(path => `./${path.replace('.ts', '')}`)
      .join(`${end}\n${start}`) + end;
    // TODO: maybe a documented 'marker/comment' inside test.ts would be nicer
    // or run typescript compiler and make changes based on the tree?
    let mockedRequireContext = '{ keys: () => ({ map: (_a: any) => { } }) };';
    mockedRequireContext += process.platform === 'win32' ? '\r\n' : '\n';
    template = template
      .replace(/declare\s+const\s+require:\s+any;/, '')
      .replace(/require\.context\(.*/, mockedRequireContext + testCode);

    fs.writeFileSync(newMainEntry, template);
  }
}

export default KarmaBuilder;
