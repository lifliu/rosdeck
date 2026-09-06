import {
  dispatchTouchEnd,
  dispatchTouchMove,
  dispatchTouchStart,
  registerTouchEntry,
  unregisterTouchEntry,
} from '../../lib/touch-dispatcher';

describe('touch dispatcher multi-stick routing', () => {
  afterEach(() => {
    unregisterTouchEntry('left-stick');
    unregisterTouchEntry('right-stick');
  });

  it('tracks two fingers on independent joystick bounds', () => {
    const leftMove = jest.fn();
    const leftEnd = jest.fn();
    const rightMove = jest.fn();
    const rightEnd = jest.fn();

    registerTouchEntry('left-stick', {
      bounds: { x: 0, y: 0, width: 100, height: 100 },
      onTouchStart: jest.fn(),
      onTouchMove: leftMove,
      onTouchEnd: leftEnd,
    });
    registerTouchEntry('right-stick', {
      bounds: { x: 120, y: 0, width: 100, height: 100 },
      onTouchStart: jest.fn(),
      onTouchMove: rightMove,
      onTouchEnd: rightEnd,
    });

    dispatchTouchStart([
      { identifier: 11, pageX: 50, pageY: 50 },
      { identifier: 22, pageX: 170, pageY: 50 },
    ]);
    dispatchTouchMove([
      { identifier: 11, pageX: 60, pageY: 30 },
      { identifier: 22, pageX: 145, pageY: 70 },
    ]);

    expect(leftMove).toHaveBeenCalledWith(11, 10, -20);
    expect(rightMove).toHaveBeenCalledWith(22, -25, 20);

    dispatchTouchEnd([{ identifier: 11, pageX: 60, pageY: 30 }]);
    dispatchTouchMove([{ identifier: 22, pageX: 190, pageY: 50 }]);

    expect(leftEnd).toHaveBeenCalledWith(11);
    expect(rightEnd).not.toHaveBeenCalled();
    expect(rightMove).toHaveBeenLastCalledWith(22, 20, 0);

    dispatchTouchEnd([{ identifier: 22, pageX: 190, pageY: 50 }]);
    expect(rightEnd).toHaveBeenCalledWith(22);
  });
});
