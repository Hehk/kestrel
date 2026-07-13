export type Cmd<Instruction> = readonly Instruction[];

export type Transition<State, Instruction> = readonly [State, Cmd<Instruction>];

export type Reactor<State, Instruction> = (oldState: State, newState: State) => Cmd<Instruction>;

export const Cmd = {
  none: <Instruction>(): Cmd<Instruction> => [],

  of: <Instruction>(instruction: Instruction): Cmd<Instruction> => [instruction],

  batch: <Instruction>(...commands: ReadonlyArray<Cmd<Instruction>>): Cmd<Instruction> =>
    commands.flat(),

  map: <From, To>(transform: (instruction: From) => To, command: Cmd<From>): Cmd<To> =>
    command.map(transform),
};

export const combineReactors = <State, Instruction>(
  reactors: ReadonlyArray<Reactor<State, Instruction>>,
): Reactor<State, Instruction> => {
  return (oldState, newState) => {
    return Cmd.batch(...reactors.map((reactor) => reactor(oldState, newState)));
  };
};

export const onChange = <State, Value, Instruction>(
  select: (state: State) => Value,
  makeCmd: (oldValue: Value, newValue: Value) => Cmd<Instruction>,
  equal: (left: Value, right: Value) => boolean = Object.is,
): Reactor<State, Instruction> => {
  return (oldState, newState) => {
    const oldValue = select(oldState);
    const newValue = select(newState);
    return equal(oldValue, newValue) ? Cmd.none() : makeCmd(oldValue, newValue);
  };
};

export const whenBecomes = <State, Instruction>(
  predicate: (state: State) => boolean,
  makeCmd: (state: State) => Cmd<Instruction>,
): Reactor<State, Instruction> => {
  return (oldState, newState) => {
    return !predicate(oldState) && predicate(newState) ? makeCmd(newState) : Cmd.none();
  };
};
