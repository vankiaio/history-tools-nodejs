// copyright defined in LICENSE.txt

const fs = require('fs');
const { TextEncoder, TextDecoder } = require('util');
const fetch = require('node-fetch');

const encoder = new TextEncoder('utf8');
const decoder = new TextDecoder('utf8');

class SerialBuffer {
    constructor({ array } = {}) {
        this.array = array || new Uint8Array(1024);
        this.length = array ? array.length : 0;
        this.readPos = 0;
    }

    reserve(size) {
        if (this.length + size <= this.array.length) {
            return;
        }
        let l = this.array.length;
        while (this.length + size > l) {
            l = Math.ceil(l * 1.5);
        }
        const newArray = new Uint8Array(l);
        newArray.set(this.array);
        this.array = newArray;
    }

    asUint8Array() {
        return new Uint8Array(this.array.buffer, this.array.byteOffset, this.length);
    }

    pushArray(v) {
        this.reserve(v.length);
        this.array.set(v, this.length);
        this.length += v.length;
    }

    get() {
        if (this.readPos < this.length) {
            return this.array[this.readPos++];
        }
        throw new Error("Read past end of buffer");
    }

    pushVaruint32(v) {
        while (true) {
            if (v >>> 7) {
                this.pushArray([0x80 | (v & 0x7f)]);
                v = v >>> 7;
            } else {
                this.pushArray([v]);
                break;
            }
        }
    }

    getVaruint32() {
        let v = 0;
        let bit = 0;
        while (true) {
            const b = this.get();
            v |= (b & 0x7f) << bit;
            bit += 7;
            if (!(b & 0x80)) {
                break;
            }
        }
        return v >>> 0;
    }

    getUint8Array(len) {
        if (this.readPos + len > this.length)
            throw new Error("Read past end of buffer");
        const result = new Uint8Array(this.array.buffer, this.array.byteOffset + this.readPos, len);
        this.readPos += len;
        return result;
    }

    pushBytes(v) {
        this.pushVaruint32(v.length);
        this.pushArray(v);
    }

    getBytes() {
        return this.getUint8Array(this.getVaruint32());
    }
} // SerialBuffer

class ClientWasm {
    constructor(path) {
        const self = this;
        this.env = {
            abort() {
                throw new Error('called abort');
            },
            eosio_assert_message(test, begin, len) {
                if (!test) {
                    let e;
                    try {
                        e = new Error('assert failed with message: ' + decoder.decode(new Uint8Array(self.inst.exports.memory.buffer, begin, len)));
                    }
                    catch (x) {
                        e = new Error('assert failed');
                    }
                    throw e;
                }
            },
            print_range(begin, end) {
                if (begin !== end)
                    process.stdout.write(decoder.decode(new Uint8Array(self.inst.exports.memory.buffer, begin, end - begin)));
            },
            get_input_data(cb_alloc_data, cb_alloc) {
                const input_data = self.input_data;
                const ptr = self.inst.exports.__indirect_function_table.get(cb_alloc)(cb_alloc_data, input_data.length);
                const dest = new Uint8Array(self.inst.exports.memory.buffer, ptr, input_data.length);
                for (let i = 0; i < input_data.length; ++i)
                    dest[i] = input_data[i];
            },
            set_output_data(begin, end) {
                self.output_data = Uint8Array.from(new Uint8Array(self.inst.exports.memory.buffer, begin, end - begin));
            },
        };

        const wasm = fs.readFileSync(path);
        this.input_data = new Uint8Array(0);
        this.mod = new WebAssembly.Module(wasm);
        this.reset();
    }

    reset() {
        this.inst = new WebAssembly.Instance(this.mod, { env: this.env });
        this.inst.exports.initialize();
    }

    describe_query_request() {
        this.inst.exports.describe_query_request();
        return JSON.parse(decoder.decode(this.output_data));
    }

    describe_query_response() {
        this.inst.exports.describe_query_response();
        return JSON.parse(decoder.decode(this.output_data));
    }

    create_query_request(request) {
        this.input_data = encoder.encode(JSON.stringify(request));
        this.output_data = new Uint8Array(0);
        this.inst.exports.create_query_request();
        return this.output_data;
    }

    decode_query_response(reply) {
        this.input_data = new Uint8Array(reply);
        this.output_data = new Uint8Array(0);
        this.inst.exports.decode_query_response();
        // console.log('<<' + decoder.decode(this.output_data) + '>>')
        return JSON.parse(decoder.decode(this.output_data));
    }

    async round_trip(request) {
        const requestBin = this.create_query_request(request);
        const bin = new SerialBuffer();
        bin.pushVaruint32(1);
        bin.pushBytes(requestBin);
        // const queryReply = await fetch('http://127.0.0.1:8880/wasmql/v1/query', { method: 'POST', body: bin.asUint8Array() });
        const queryReply = await fetch('http://vkthistoryapi.greaspace.com/wasmql/v1/query', { method: 'POST', body: bin.asUint8Array() });
        if (queryReply.status !== 200)
            throw new Error(queryReply.status + ': ' + queryReply.statusText + ': ' + await queryReply.text());
        const reply = new SerialBuffer({ array: new Uint8Array(await queryReply.arrayBuffer()) });
        if (reply.getVaruint32() != 1)
            throw new Error("expected 1 reply")
        return this.decode_query_response(reply.getBytes());
    }
} // ClientWasm

function amount_to_decimal(amount) {
    let s;
    if (amount.amount[0] === '-')
        s = '-' + amount.amount.substr(1).padStart(amount.precision + 1, '0');
    else
        s = amount.amount.padStart(amount.precision + 1, '0');
    return s.substr(0, s.length - amount.precision) + '.' + s.substr(s.length - amount.precision);
}

function format_asset(amount, number_size = 18) {
    return amount_to_decimal(amount).padStart(number_size, ' ') + ' ' + amount.symbol;
}

function format_extended_asset(amount, number_size = 18) {
    return amount_to_decimal(amount).padStart(number_size, ' ') + ' ' + amount.symbol + '@' + amount.contract;
}

async function dump_block_info(clientWasm, first, last) {
    do {
        const reply = await clientWasm.round_trip(['block.info', {
            first, last,
            max_results: 100,
        }]);
        for (let block of reply[1].blocks)
            console.log(JSON.stringify(block, null, 4));
        first = reply[1].more;
    } while (first);
}

async function dump_tapos(clientWasm, ref_block, expire_seconds) {
    const reply = await clientWasm.round_trip(['tapos', {
        ref_block,
        expire_seconds,
    }]);
    console.log(JSON.stringify(reply, null, 4));
}

async function dump_accounts(clientWasm, snapshot_block, first, last) {
    do {
        const reply = await clientWasm.round_trip(['account', {
            snapshot_block,
            first: first,
            last: last,
            max_results: 100,
            include_abi: false,
        }]);
        console.log(JSON.stringify(reply, null, 4));
        first = reply[1].more;
    } while (first);
}

async function get_abi(clientWasm, names) {
    const reply = await clientWasm.round_trip(['abi', {
        snapshot_block: ["irreversible", 0],
        names,
    }]);
    console.log(JSON.stringify(reply, null, 4));
}

async function get_code(clientWasm, names) {
    const reply = await clientWasm.round_trip(['code', {
        snapshot_block: ["irreversible", 0],
        names,
    }]);
    console.log(JSON.stringify(reply, null, 4));
}

async function dump_eos_balances(snapshot_block, clientWasm, first_account, last_account) {
    do {
        const reply = await clientWasm.round_trip(['bal.mult.acc', {
            snapshot_block,
            code: 'eosio.token',
            sym: 'VKT',
            first_account: first_account,
            last_account: last_account,
            max_results: 100,
        }]);
        for (let balance of reply[1].balances)
            console.log(balance.account.padEnd(13, ' '), format_extended_asset(balance.amount));
        first_account = reply[1].more;
    } while (first_account);
}

async function dump_tokens(clientWasm, account, snapshot_block, first_key, last_key) {
    do {
        const reply = await clientWasm.round_trip(['bal.mult.tok', {
            snapshot_block,
            account,
            first_key,
            last_key,
            max_results: 100,
        }]);
        for (let balance of reply[1].balances)
            console.log(balance.account.padEnd(13, ' '), format_extended_asset(balance.amount));
        first_key = reply[1].more;
    } while (first_key);
}

async function dump_transfers(clientWasm) {
    let first_key = {
        receiver: 'eosio.bpay',
        account: 'eosio.token',
        block: ['absolute', 0],
        transaction_id: '0000000000000000000000000000000000000000000000000000000000000000',
        action_ordinal: 0,
    };
    let last_key = {
        receiver: 'eosio.bpay',
        account: 'eosio.token',
        block: ['irreversible', 0],
        transaction_id: 'ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff',
        action_ordinal: 0xffffffff,
    };

    let i = 0;
    while (first_key) {
        const reply = await clientWasm.round_trip(['transfer', {
            snapshot_block: ["irreversible", 0],
            first_key,
            last_key,
            max_results: 10,
            include_notify_incoming: true,
            include_notify_outgoing: true,
        }]);
        for (let transfer of reply[1].transfers)
            console.log(
                transfer.from.padEnd(13, ' ') + ' -> ' + transfer.to.padEnd(13, ' '),
                format_extended_asset(transfer.quantity), '     ', transfer.memo);
        first_key = reply[1].more;
        i += reply[1].transfers.length;
        console.log(i);
        if (i >= 20)
            break;
    }
}

(async () => {
    try {
        const chainWasm = new ClientWasm('../history-tools/build/chain-client.wasm');
        const tokenWasm = new ClientWasm('../history-tools/build/token-client.wasm');

        fs.writeFileSync('chain_request_schema.json', JSON.stringify(chainWasm.describe_query_request(), null, 4));
        fs.writeFileSync('chain_response_schema.json', JSON.stringify(chainWasm.describe_query_response(), null, 4));
        fs.writeFileSync('token_request_schema.json', JSON.stringify(tokenWasm.describe_query_request(), null, 4));
        fs.writeFileSync('token_response_schema.json', JSON.stringify(tokenWasm.describe_query_response(), null, 4));

        await dump_block_info(chainWasm, ["head", 0], ["head", 1]);
        console.log();
        await dump_tapos(chainWasm, ["head", -3], 0);
        console.log();
        await dump_accounts(chainWasm, ["irreversible", 0], 'eosio', 'eosio.bpay')
        console.log();
        await get_abi(chainWasm, ['eosio', 'eosio.token', 'eosio.null', 'eosio.nope']);
        console.log();
        await get_code(chainWasm, ['eosio.null']);
        console.log();
        await dump_eos_balances(["head", 0], tokenWasm, 'eosio', 'eosio.zzzzzzj');
        console.log();
        await dump_eos_balances(["irreversible", 5000], tokenWasm, '', 'zzzzzzzzzzzzj');
        console.log();
        await dump_tokens(tokenWasm, 'b1', ["irreversible", 0], { sym: '', code: '' }, { sym: 'ZZZZZZZ', code: 'zzzzzzzzzzzzj' });
        console.log();
        await dump_transfers(tokenWasm);
    } catch (e) {
        console.error(e);
    }
})();
