/**
 * @license
 * Copyright Google Inc. All Rights Reserved.
 *
 * Use of this source code is governed by an MIT-style license that can be
 * found in the LICENSE file at https://angular.io/license
 */
import { DefaultTimeout, runTargetSpec } from '@angular-devkit/architect/testing';
import { logging, normalize, virtualFs } from '@angular-devkit/core';
import { tap } from 'rxjs/operators';
import { NormalizedKarmaBuilderSchema } from '../../src';
import { host, karmaTargetSpec } from '../utils';

describe('Karma Builder', () => {
  beforeEach(done => host.initialize().toPromise().then(done, done.fail));
  afterEach(done => host.restore().toPromise().then(done, done.fail));

  it('should fail spec option doesn\'t match any files', async (done) => {
    const overrides: Partial<NormalizedKarmaBuilderSchema> = { spec: '---404' };
    const logger = new logging.Logger('test');
    const loggerSpy = jasmine.createSpy();
    logger.subscribe(loggerSpy);
    runTargetSpec(host, karmaTargetSpec, overrides, DefaultTimeout, logger).pipe(
      tap((buildEvent) => {
        expect(buildEvent.success).toBe(false, 'build failed');
        expect(loggerSpy).toHaveBeenCalledWith(jasmine.objectContaining({
          message: 'Specified spec glob does not match any files',
        }));
      }),
    ).toPromise().then(done, done.fail);
  }, 30000);

  describe('selected tests', () => {
    beforeEach(() => {
      host.writeMultipleFiles({
        'src/app/test.service.spec.ts': `
          describe('TestService', () => {
            it('should succeed', () => {
              expect(true).toBe(true);
            });
          });`,
        'src/app/failing.service.spec.ts': `
          describe('FailingService', () => {
            it('should be ignored', () => {
              expect(true).toBe(false);
            });
          });`,
      });
    });
    [
      { message: 'absolute path to spec', path: 'src/app/test.service.spec.ts' },
      { message: 'relative path from root to spec', path: 'app/test.service.spec.ts' },
      { message: 'glob without spec suffix', path: '**/test.service' },
      { message: 'glob with spec suffix', path: '**/test.service.spec.ts' },
    ].forEach((options) => {

      it('should work with ' + options.message, (done) => {
        const overrides: Partial<NormalizedKarmaBuilderSchema> = { spec: options.path };
        runTargetSpec(host, karmaTargetSpec, overrides).pipe(
          tap((buildEvent) => {
            expect(buildEvent.success).toBe(true, 'build failed');
          }),
        ).toPromise().then(done, done.fail);
      }, 30000);
    });
  });

  it('should only update generated file', (done) => {
    const overrides: Partial<NormalizedKarmaBuilderSchema> = {
      spec: '**/app.component.spec.ts',
      specUpdate: true,
    };
    const newEntryPoint = normalize('src/test.generated.ts');
    runTargetSpec(host, karmaTargetSpec, overrides).pipe(
      tap((buildEvent) => {
        expect(buildEvent.success).toBe(true, 'build failed');
        expect(buildEvent.result).toEqual('specs updated');

        expect(host.scopedSync().exists(newEntryPoint)).toBe(true);
        const content = virtualFs.fileBufferToString(host.scopedSync().read(newEntryPoint));
        expect(content).toContain('import \'./app/app.component.spec\';');
        expect(content).toContain('{ keys: () => ({ map: (_a: any) => { } }) }');
      }),
    ).toPromise().then(done, done.fail);
  }, 30000);

});
