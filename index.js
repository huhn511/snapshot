const express = require('express')
const bodyParser = require('body-parser')
const cors = require('cors');

const low = require('lowdb')
const FileAsync = require('lowdb/adapters/FileAsync')
const fetch = require('node-fetch');

const ipfsClient = require('ipfs-http-client')

const ipfs = ipfsClient('ipfs', '5001', { protocol: 'http' })

const CronJob = require('cron').CronJob;

const Mam = require('@iota/mam');
const { PROVIDER, URL, APP_PORT } = require('./config.json');

const { asciiToTrytes } = require('@iota/converter')
const generateSeed = require('iota-generate-seed');

let mamState;

const PORT = APP_PORT || 3000

// Create server
const app = express()
app.use(cors());
app.use(bodyParser.json())

// Create database instance and start server
const adapter = new FileAsync('db.json')
low(adapter)
    .then(db => {
        // Routes
        // GET /snapshots/:id
        app.get('/snapshots/:id', (req, res) => {
            const post = db.get('snapshots')
                .find({ id: req.params.id })
                .value()

            res.send(post)
        })

        // GET /snapshots
        app.get('/snapshots', (req, res) => {
            const posts = db.get('snapshots')
                .value()
            res.send(posts)
        })


        // GET /root
        app.get('/', (req, res) => {
            const root = db.get('config.root')
                .value()
            res.send(root)
        })


        // POST /snapshots
        app.post('/snapshots', async (req, res) => {

            publishSnapshot().then(snapshot => {
                db.get('snapshots')
                    .push(snapshot)
                    .last()
                    .assign({ id: Date.now().toString() })
                    .write()
                    .then(post => res.send(post))
            })


        })

        // Initialise MAM State
        let seed = db.get('config.seed').value()

        if (seed) {
            mamState = Mam.init(PROVIDER, seed)
            let old_state = db.get('config.state').value()
            updateMamState(old_state);

        } else {
            seed = generateSeed()
            db.set('config.seed', seed)
                .write()

            mamState = Mam.init(PROVIDER, seed)

            db.set('config.root', Mam.getRoot(mamState))
                .write()
        }

        new CronJob('0 */1 * * * *', async function () {
            publishSnapshot().then((response) => {
                db.set('config.state', response.state)
                    .write()

                db.get('snapshots')
                    .push(response.snapshot)
                    .last()
                    .assign({ id: Date.now().toString() })
                    .write()
            })

        }, null, true, 'America/Los_Angeles');

        // Set db default values
        return db.defaults({ snapshots: [], config: {} }).write()
    })
    .then(() => {
        app.listen(PORT, () => console.log('Server listening on port 3000'))
    })

const fetchData = async () => {

    let response = await fetch(URL);
    let json = await response.json();
    return json
}

const publishToIPFS = async data => {
    let doc = JSON.stringify(data);
    let content = ipfsClient.Buffer.from(doc)
    let results = await ipfs.add(content)
    let ipfs_hash = results[0].hash

    return ipfs_hash
}

const updateMamState = newMamState => (mamState = newMamState);

// Publish to tangle
const publishToMAM = async data => {

    // Create MAM Payload - STRING OF TRYTES
    const trytes = asciiToTrytes(JSON.stringify(data))

    const message = Mam.create(mamState, trytes)

    // Save new mamState
    updateMamState(message.state);

    // Attach the payload
    let x = await Mam.attach(message.payload, message.address, 3, 9)

    return message
}

const publishSnapshot = async () => {
    let data = await fetchData()
    let ipfs_hash = await publishToIPFS(data)
    let mam_message = {
        timestamp: Date.now(),
        ipfs_hash: ipfs_hash
    }
    let mam = await publishToMAM(mam_message)
    let snapshot = {
        ...mam_message,
        root: mam.root
    }

    return { snapshot: snapshot, state: mam.state }
}