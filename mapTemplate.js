import { GameObject, ObjectTypes } from './objects.js';

export function createDefaultMap() {
    return [
        new GameObject(0, 550, 800, 50, ObjectTypes.GROUND),
        new GameObject(0, 0, 50, 600, ObjectTypes.GROUND),
        new GameObject(750, 0, 50, 600, ObjectTypes.GROUND),
        new GameObject(0, 0, 800, 50, ObjectTypes.GROUND),
        new GameObject(200, 400, 150, 20, ObjectTypes.GROUND),
        new GameObject(450, 300, 150, 20, ObjectTypes.GROUND),
        new GameObject(150, 480, 150, 70, ObjectTypes.WATER),
        new GameObject(300, 530, 60, 20, ObjectTypes.JUMPPAD, { force: -12 })
    ];
}
