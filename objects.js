export const ObjectTypes = {
    GROUND: 'ground',
    WATER: 'water',
    JUMPPAD: 'jumppad'
};

export class GameObject {
    constructor(x, y, width, height, type, properties = {}) {
        this.x = x;
        this.y = y;
        this.width = width;
        this.height = height;
        this.type = type;
        this.properties = properties;
    }

    draw(ctx) {
        if (this.type === ObjectTypes.GROUND) {
            ctx.fillStyle = '#555';
        } else if (this.type === ObjectTypes.WATER) {
            ctx.fillStyle = 'rgba(0, 120, 255, 0.4)';
        } else if (this.type === ObjectTypes.JUMPPAD) {
            ctx.fillStyle = '#ffaa00';
        } else {
            ctx.fillStyle = '#333';
        }
        ctx.fillRect(this.x, this.y, this.width, this.height);
    }
}
