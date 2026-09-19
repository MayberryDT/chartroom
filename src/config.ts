import {resolve,join} from 'node:path';
export const home=resolve(process.env.CHARTROOM_HOME || '.chartroom');
export const port=Number(process.env.CHARTROOM_PORT || 3141);
if(!Number.isInteger(port)||port<1024||port>65535)throw Error('CHARTROOM_PORT must be 1024..65535');
export const endpoint=`http://127.0.0.1:${port}/mcp`;
export const tokenPath=join(home,'client.token');
