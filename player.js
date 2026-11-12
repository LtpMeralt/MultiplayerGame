export class Player {
    constructor(id, username, color) {
        this.id = id;
        this.username = username;
        this.color = color;
        this.x = 100;
        this.y = 100;
        this.vx = 0;
        this.vy = 0;
        this.radius = 15;
        this.speed = 0.5;
        this.friction = 0.98;
        this.gravity = 0.4;
        this.isGrounded = false;
    }

    update(keys, objects) {
        if (keys['ArrowLeft'] || keys['KeyA']) this.vx -= this.speed;
        if (keys['ArrowRight'] || keys['KeyD']) this.vx += this.speed;
        if ((keys['ArrowUp'] || keys['KeyW']) && this.isGrounded) {
            this.vy = -10;
            this.isGrounded = false;
        }

        this.vy += this.gravity;
        this.vx *= this.friction;
        this.vy *= this.friction;

        this.x += this.vx;
        this.y += this.vy;

        this.isGrounded = false;
        for (let obj of objects) {
            let closestX = Math.max(obj.x, Math.min(this.x, obj.x + obj.width));
            let closestY = Math.max(obj.y, Math.min(this.y, obj.y + obj.height));
            
            let distX = this.x - closestX;
            let distY = this.y - closestY;
            let distance = Math.sqrt(distX * distX + distY * distY);

            if (distance < this.radius) {
                if (obj.type === 'ground') {
                    if (Math.abs(distX) > Math.abs(distY)) {
                        this.x = closestX + (distX > 0 ? this.radius : -this.radius);
                        this.vx = 0;
                    } else {
                        this.y = closestY + (distY > 0 ? this.radius : -this.radius);
                        if (distY < 0) this.isGrounded = true;
                        this.vy = 0;
                    }
                } else if (obj.type === 'water') {
                    this.vx *= 0.85;
                    this.vy *= 0.85;
                } else if (obj.type === 'jumppad') {
                    this.vy = obj.properties.force || -12;
                }
            }
        }
    }

    draw(ctx) {
        ctx.beginPath();
        ctx.arc(this.x, this.y, this.radius, 0, Math.PI * 2);
        ctx.fillStyle = this.color;
        ctx.fill();
        ctx.lineWidth = 2;
        ctx.strokeStyle = '#fff';
        ctx.stroke();
        ctx.closePath();

        ctx.fillStyle = '#fff';
        ctx.font = '12px monospace';
        ctx.textAlign = 'center';
        ctx.fillText(this.username, this.x, this.y - this.radius - 6);
    }
}
