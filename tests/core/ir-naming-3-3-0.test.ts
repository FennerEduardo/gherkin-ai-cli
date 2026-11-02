/* ==========================================================================
   Command naming fixes of 3.3.0, found by `ghk reverse` (PLAN-3.3.0 IR-05, IR-06)

   IR-05: a relative clause ends the noun phrase of a command.
   IR-06: a verb of the extended list names its own command next to core
   ones; a synonym of a core verb on the same noun is the same command (no
   repetition); next to core commands, an extended verb that only repeats
   its noun or asks for data is left out.
   ========================================================================== */

import { describe, it, expect } from 'vitest';
import { parseGherkinText } from '../../src/core/gherkin-parser';
import { buildDomainModel } from '../../src/generators/kernel/domain-model';

const commands = (when: string[]) => buildDomainModel(parseGherkinText(
  `Feature: Orders\n  As a customer\n${when.map((w, i) => `  Scenario: S${i}\n    Given a customer\n    When ${w}\n    Then it is done\n`).join('')}`
)).commands.map(c => c.name);

describe('IR-05: relative clauses end the command noun', () => {
  it('"cancels an order that does not exist" is CancelOrder', () => {
    expect(commands(['the customer cancels the order', 'the customer cancels an order that does not exist'])).toEqual(['CancelOrder']);
    expect(commands(['the manager approves the request which is pending'])).toEqual(['ApproveRequest']);
    expect(commands(['the manager approves that request'])).toEqual(['ApproveRequest']);
  });
});

describe('IR-06: extended verbs next to core verbs', () => {
  it('names the extended command too (PlaceOrder next to CancelOrder)', () => {
    expect(commands(['the customer places an order for 2 items', 'the customer cancels the order'])).toEqual(['PlaceOrder', 'CancelOrder']);
  });

  it('a synonym of a core verb on the same noun is one command, named by the core verb', () => {
    expect(commands(['the customer creates an order', 'the customer places an order'])).toEqual(['CreateOrder']);
    expect(commands(['the clerk sends the parcel', 'the clerk ships the parcel'])).toEqual(['SendParcel']);
  });

  it('next to core commands, leaves out an extended verb that repeats its noun or asks for data', () => {
    expect(commands(['the teacher publishes the grade', 'the teacher grades the grade'])).toEqual(['PublishGrade']);
    expect(commands(['the admin assigns the role', 'the admin requests the members'])).toEqual(['AssignRole']);
  });

  it('without core commands the extended verbs still name the commands (3.2.2 behaviour)', () => {
    expect(commands(['the customer places an order'])).toEqual(['PlaceOrder']);
  });
});
