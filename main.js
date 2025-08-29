import * as THREE from 'three';
import { FBXLoader } from 'three/examples/jsm/loaders/FBXLoader.js';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { VRMLoaderPlugin, VRMUtils } from '@pixiv/three-vrm';

class BVHParser {
    parse(content) {
        const lines = content.split('\n').map(line => line.trim()).filter(line => line);
        let index = 0;
        
        if (lines[index] !== 'HIERARCHY') {
            throw new Error('Invalid BVH file: missing HIERARCHY section. Found: ' + lines[index]);
        }
        index++;
        
        const skeleton = this.parseHierarchy(lines, index);
        
        const motionIndex = lines.findIndex(line => line === 'MOTION');
        if (motionIndex === -1) {
            throw new Error('Invalid BVH file: missing MOTION section');
        }
        
        const motionData = this.parseMotion(lines, motionIndex + 1);
        
        return {
            skeleton: skeleton.node,
            motionData,
            totalChannels: skeleton.totalChannels
        };
    }
    
    parseHierarchy(lines, startIndex) {
        let index = startIndex;
        
        const parseNode = (isRoot = false) => {
            if (index >= lines.length) {
                throw new Error(`Unexpected end of file while parsing hierarchy at index ${index}`);
            }
            
            const line = lines[index];
            const parts = line.split(/\s+/);
            
            let nodeType, nodeName;
            if (isRoot) {
                nodeType = parts[0]; // ROOT
                nodeName = parts[1];
            } else {
                nodeType = parts[0]; // JOINT or End Site
                nodeName = parts[1] || 'End Site';
            }
            index++;
            
            if (index >= lines.length) {
                throw new Error(`Unexpected end of file after ${nodeType} ${nodeName}`);
            }
            
            if (lines[index] !== '{') {
                throw new Error(`Expected '{' after ${nodeType} ${nodeName}, but found: "${lines[index]}" at line ${index}`);
            }
            index++;
            
            const node = {
                name: nodeName,
                type: nodeType,
                offset: [0, 0, 0],
                channels: [],
                children: []
            };
            
            let totalChannels = 0;
            
            while (index < lines.length && lines[index] !== '}') {
                const currentLine = lines[index];
                
                if (currentLine.startsWith('OFFSET')) {
                    const offsetParts = currentLine.split(/\s+/);
                    node.offset = [
                        parseFloat(offsetParts[1]),
                        parseFloat(offsetParts[2]),
                        parseFloat(offsetParts[3])
                    ];
                    index++;
                } else if (currentLine.startsWith('CHANNELS')) {
                    const channelParts = currentLine.split(/\s+/);
                    const numChannels = parseInt(channelParts[1]);
                    node.channels = channelParts.slice(2, 2 + numChannels);
                    totalChannels += numChannels;
                    index++;
                } else if (currentLine.startsWith('JOINT')) {
                    const childResult = parseNode();
                    node.children.push(childResult.node);
                    totalChannels += childResult.totalChannels;
                } else if (currentLine.startsWith('End Site')) {
                    const endSiteResult = parseNode();
                    node.children.push(endSiteResult.node);
                    totalChannels += endSiteResult.totalChannels;
                } else {
                    index++;
                }
            }
            
            if (lines[index] === '}') {
                index++;
            }
            
            return { node, totalChannels };
        };
        
        const rootResult = parseNode(true);
        return { node: rootResult.node, totalChannels: rootResult.totalChannels, endIndex: index };
    }
    
    parseMotion(lines, startIndex) {
        let index = startIndex;
        
        if (index >= lines.length) {
            throw new Error('Unexpected end of file in MOTION section');
        }
        
        const framesLine = lines[index];
        const framesMatch = framesLine.match(/Frames:\s*(\d+)/);
        if (!framesMatch) {
            throw new Error(`Invalid MOTION section: missing or invalid Frames line. Found: "${framesLine}"`);
        }
        const frameCount = parseInt(framesMatch[1]);
        index++;
        
        if (index >= lines.length) {
            throw new Error('Unexpected end of file after Frames line');
        }
        
        const frameTimeLine = lines[index];
        const frameTimeMatch = frameTimeLine.match(/Frame Time:\s*([\d.]+)/);
        if (!frameTimeMatch) {
            throw new Error(`Invalid MOTION section: missing or invalid Frame Time line. Found: "${frameTimeLine}"`);
        }
        const frameTime = parseFloat(frameTimeMatch[1]);
        index++;
        
        const frames = [];
        for (let i = 0; i < frameCount && index < lines.length; i++) {
            if (index >= lines.length) {
                console.warn(`Warning: Expected ${frameCount} frames but only found ${i} frames`);
                break;
            }
            const frameData = lines[index].split(/\s+/).map(val => parseFloat(val));
            frames.push(frameData);
            index++;
        }
        return {
            frameCount: frames.length, // 実際に読み込まれたフレーム数
            frameTime,
            frames
        };
    }
}

class ModelViewer {
    constructor() {
        this.scene = null;
        this.camera = null;
        this.renderer = null;
        this.controls = null;
        
        // BVH関連
        this.skeleton = null;
        this.skeletonHelper = null;
        this.motionData = null;
        this.totalChannels = 0;
        this.bones = new Map();
        this.frameObjects = [];
        this.boneConnections = [];
        this.skeletonGroup = null;
        this.skeletonScale = 1;
        
        // アニメーション関連
        this.isPlaying = false;
        this.currentFrame = 0;
        this.playSpeed = 1.0;
        this.lastFrameTime = 0;
        this.frameAccumulator = 0;
        this.mixer = null;
        
        // 現在のモデル
        this.currentModel = null;
        this.currentModelType = null;
        
        // ローダー
        this.fbxLoader = new FBXLoader();
        this.gltfLoader = new GLTFLoader();
        this.gltfLoader.register((parser) => {
            return new VRMLoaderPlugin(parser);
        });
        
        this.init();
        this.setupEventListeners();
        this.setupTabs();
    }
    
    init() {
        const canvas = document.getElementById('canvas');
        
        // Scene
        this.scene = new THREE.Scene();
        this.scene.background = new THREE.Color(0x1a1a1a);
        
        // Camera
        this.camera = new THREE.PerspectiveCamera(75, canvas.clientWidth / canvas.clientHeight, 0.1, 1000);
        this.camera.position.set(0, 80, 120);
        this.camera.lookAt(0, 40, 0); // より下を見るように調整
        
        // Renderer
        this.renderer = new THREE.WebGLRenderer({ canvas: canvas, antialias: true });
        this.renderer.setSize(canvas.clientWidth, canvas.clientHeight);
        this.renderer.shadowMap.enabled = true;
        this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
        
        // Lighting
        this.ambientLight = new THREE.AmbientLight(0x404040, 0.6);
        this.scene.add(this.ambientLight);
        
        this.directionalLight = new THREE.DirectionalLight(0xffffff, 0.8);
        this.directionalLight.position.set(50, 100, 50);
        this.directionalLight.castShadow = true;
        this.directionalLight.shadow.mapSize.width = 2048;
        this.directionalLight.shadow.mapSize.height = 2048;
        this.scene.add(this.directionalLight);
        
        // FBX/VRM用の追加ライト
        this.fillLight = new THREE.DirectionalLight(0xffffff, 0.3);
        this.fillLight.position.set(-50, 50, -50);
        this.scene.add(this.fillLight);
        
        this.backLight = new THREE.DirectionalLight(0xffffff, 0.2);
        this.backLight.position.set(0, 50, -100);
        this.scene.add(this.backLight);
        
        // Ground removed
        
        // Controls
        this.setupControls();
        
        // Resize handler
        window.addEventListener('resize', () => this.onWindowResize());
        
        this.animate();
    }
    
    setupControls() {
        let isMouseDown = false;
        let mouseX = 0;
        let mouseY = 0;
        let rotationX = -0.2; // 初期の下向き角度
        let rotationY = 0;
        let radius = 150; // 固定半径
        
        const canvas = this.renderer.domElement;
        const center = new THREE.Vector3(0, 40, 0); // 回転中心
        
        // カメラ位置を更新する関数
        const updateCameraPosition = () => {
            this.camera.position.x = Math.cos(rotationY) * Math.cos(rotationX) * radius + center.x;
            this.camera.position.y = Math.sin(rotationX) * radius + center.y;
            this.camera.position.z = Math.sin(rotationY) * Math.cos(rotationX) * radius + center.z;
            this.camera.lookAt(center);
        };
        
        // 初期位置を設定
        updateCameraPosition();
        
        canvas.addEventListener('mousedown', (event) => {
            isMouseDown = true;
            mouseX = event.clientX;
            mouseY = event.clientY;
        });
        
        canvas.addEventListener('mousemove', (event) => {
            if (!isMouseDown) return;
            
            const deltaX = event.clientX - mouseX;
            const deltaY = event.clientY - mouseY;
            
            // 回転角度のみ更新（距離は固定）
            rotationY += deltaX * 0.005;
            rotationX -= deltaY * 0.005; // 反転して自然な操作感に
            
            // 上下角度を制限
            rotationX = Math.max(-Math.PI / 2 * 0.9, Math.min(Math.PI / 2 * 0.9, rotationX));
            
            // カメラ位置更新
            updateCameraPosition();
            
            mouseX = event.clientX;
            mouseY = event.clientY;
        });
        
        canvas.addEventListener('mouseup', () => {
            isMouseDown = false;
        });
        
        // 中心固定ズーム
        canvas.addEventListener('wheel', (event) => {
            event.preventDefault();
            
            const scaleFactor = event.deltaY > 0 ? 1.1 : 0.9;
            radius *= scaleFactor;
            
            // ズーム範囲を制限
            radius = Math.max(50, Math.min(500, radius));
            
            // カメラ位置更新（中心は固定）
            updateCameraPosition();
        });
    }
    
    setupTabs() {
        const tabs = document.querySelectorAll('.tab');
        const tabContents = document.querySelectorAll('.tab-content');
        
        tabs.forEach(tab => {
            tab.addEventListener('click', () => {
                const tabName = tab.dataset.tab;
                
                // タブの切り替え
                tabs.forEach(t => t.classList.remove('active'));
                tabContents.forEach(content => content.classList.remove('active'));
                
                tab.classList.add('active');
                document.getElementById(`${tabName}-content`).classList.add('active');
                
                // モデルをクリア
                this.clearScene();
            });
        });
    }
    
    setupEventListeners() {
        const uploadAreas = document.querySelectorAll('.upload-area');
        const playBtn = document.getElementById('playBtn');
        const pauseBtn = document.getElementById('pauseBtn');
        const resetBtn = document.getElementById('resetBtn');
        const speedControl = document.getElementById('speedControl');
        const speedValue = document.getElementById('speedValue');
        
        // 各アップロードエリアにイベント設定
        uploadAreas.forEach(uploadArea => {
            const fileInput = uploadArea.querySelector('.file-input');
            const fileType = uploadArea.dataset.type;
            
            uploadArea.addEventListener('click', () => fileInput.click());
            
            uploadArea.addEventListener('dragover', (e) => {
                e.preventDefault();
                uploadArea.classList.add('dragover');
            });
            
            uploadArea.addEventListener('dragleave', () => {
                uploadArea.classList.remove('dragover');
            });
            
            uploadArea.addEventListener('drop', (e) => {
                e.preventDefault();
                uploadArea.classList.remove('dragover');
                const files = e.dataTransfer.files;
                if (files.length > 0) {
                    this.loadFile(files[0], fileType);
                }
            });
            
            fileInput.addEventListener('change', (e) => {
                if (e.target.files.length > 0) {
                    this.loadFile(e.target.files[0], fileType);
                }
            });
        });
        
        playBtn.addEventListener('click', () => this.play());
        pauseBtn.addEventListener('click', () => this.pause());
        resetBtn.addEventListener('click', () => this.reset());
        
        speedControl.addEventListener('input', (e) => {
            this.playSpeed = parseFloat(e.target.value);
            speedValue.textContent = this.playSpeed.toFixed(1);
        });
        
        // ライティング制御（FBX用）
        const ambientIntensity = document.getElementById('ambientIntensity');
        const ambientValue = document.getElementById('ambientValue');
        const directionalIntensity = document.getElementById('directionalIntensity');
        const directionalValue = document.getElementById('directionalValue');
        
        if (ambientIntensity) {
            ambientIntensity.addEventListener('input', (e) => {
                const value = parseFloat(e.target.value);
                this.ambientLight.intensity = value;
                ambientValue.textContent = value.toFixed(1);
            });
        }
        
        if (directionalIntensity) {
            directionalIntensity.addEventListener('input', (e) => {
                const value = parseFloat(e.target.value);
                this.directionalLight.intensity = value;
                this.fillLight.intensity = value * 0.4;
                this.backLight.intensity = value * 0.3;
                directionalValue.textContent = value.toFixed(1);
            });
        }
        
        // ライティング制御（VRM用）
        const ambientIntensityVrm = document.getElementById('ambientIntensityVrm');
        const ambientValueVrm = document.getElementById('ambientValueVrm');
        const directionalIntensityVrm = document.getElementById('directionalIntensityVrm');
        const directionalValueVrm = document.getElementById('directionalValueVrm');
        
        if (ambientIntensityVrm) {
            ambientIntensityVrm.addEventListener('input', (e) => {
                const value = parseFloat(e.target.value);
                this.ambientLight.intensity = value;
                ambientValueVrm.textContent = value.toFixed(1);
            });
        }
        
        if (directionalIntensityVrm) {
            directionalIntensityVrm.addEventListener('input', (e) => {
                const value = parseFloat(e.target.value);
                this.directionalLight.intensity = value;
                this.fillLight.intensity = value * 0.4;
                this.backLight.intensity = value * 0.3;
                directionalValueVrm.textContent = value.toFixed(1);
            });
        }
    }
    
    async loadFile(file, fileType) {
        this.clearScene();
        
        try {
            switch (fileType) {
                case 'bvh':
                    await this.loadBVHFile(file);
                    break;
                case 'fbx':
                    await this.loadFBXFile(file);
                    break;
                case 'vrm':
                    await this.loadVRMFile(file);
                    break;
                default:
                    throw new Error('Unsupported file type: ' + fileType);
            }
        } catch (error) {
            console.error(`Error loading ${fileType.toUpperCase()} file:`, error);
            alert(`${fileType.toUpperCase()}ファイルの読み込みに失敗しました: ` + error.message);
        }
    }
    
    async loadBVHFile(file) {
        const content = await this.readFile(file);
        const parser = new BVHParser();
        const result = parser.parse(content);
        
        this.skeleton = result.skeleton;
        this.motionData = result.motionData;
        this.totalChannels = result.totalChannels;
        this.currentModelType = 'bvh';
        
        this.createSkeleton();
        this.enableControls();
        
        // BVH情報を表示
        this.displayBVHInfo();
        
        const fps = (1.0 / this.motionData.frameTime).toFixed(1);
        console.log(`BVH file loaded: ${this.motionData.frameCount} frames, ${this.totalChannels} channels, ${fps} FPS`);
    }
    
    async loadFBXFile(file) {
        const url = URL.createObjectURL(file);
        const fbx = await new Promise((resolve, reject) => {
            this.fbxLoader.load(url, resolve, undefined, reject);
        });
        
        URL.revokeObjectURL(url);
        
        this.currentModel = fbx;
        this.currentModelType = 'fbx';
        this.scene.add(fbx);
        
        // FBX用ライティング強化
        this.enhanceLightingForModels();
        
        // FBXアニメーション設定
        if (fbx.animations && fbx.animations.length > 0) {
            this.mixer = new THREE.AnimationMixer(fbx);
            const action = this.mixer.clipAction(fbx.animations[0]);
            action.play();
            this.enableControls();
        }
        
        // モデルを適切にスケール・配置
        this.normalizeModel(fbx);
        
        // ライティングコントロール表示
        document.getElementById('fbx-lighting').style.display = 'block';
        
        console.log('FBX file loaded successfully');
    }
    
    async loadVRMFile(file) {
        const url = URL.createObjectURL(file);
        const gltf = await new Promise((resolve, reject) => {
            this.gltfLoader.load(url, resolve, undefined, reject);
        });
        
        URL.revokeObjectURL(url);
        
        const vrm = gltf.userData.vrm;
        if (vrm) {
            VRMUtils.removeUnnecessaryVertices(gltf.scene);
            VRMUtils.removeUnnecessaryJoints(gltf.scene);
        }
        
        this.currentModel = gltf.scene;
        this.currentModelType = 'vrm';
        this.scene.add(gltf.scene);
        
        // VRM用ライティング強化
        this.enhanceLightingForModels();
        
        // VRMアニメーション設定
        if (gltf.animations && gltf.animations.length > 0) {
            this.mixer = new THREE.AnimationMixer(gltf.scene);
            const action = this.mixer.clipAction(gltf.animations[0]);
            action.play();
            this.enableControls();
        }
        
        // モデルを適切にスケール・配置
        this.normalizeModel(gltf.scene);
        
        // ライティングコントロール表示
        document.getElementById('vrm-lighting').style.display = 'block';
        
        console.log('VRM file loaded successfully');
    }
    
    enhanceLightingForModels() {
        // FBX/VRM用により明るいライティングに調整
        this.ambientLight.intensity = 1.2;
        this.directionalLight.intensity = 1.5;
        this.fillLight.intensity = 0.6;
        this.backLight.intensity = 0.4;
    }
    
    clearScene() {
        // 既存のモデルを削除
        if (this.skeletonGroup) {
            this.scene.remove(this.skeletonGroup);
            this.skeletonGroup = null;
        }
        
        if (this.currentModel) {
            this.scene.remove(this.currentModel);
            this.currentModel = null;
        }
        
        // BVH関連をリセット
        this.frameObjects.forEach(obj => this.scene.remove(obj));
        this.frameObjects = [];
        this.bones.clear();
        this.boneConnections = [];
        
        // アニメーション関連をリセット
        if (this.mixer) {
            this.mixer.stopAllAction();
            this.mixer = null;
        }
        
        this.isPlaying = false;
        this.currentFrame = 0;
        this.skeleton = null;
        this.motionData = null;
        this.currentModelType = null;
        
        // ライティングをデフォルトに戻す
        this.ambientLight.intensity = 0.6;
        this.directionalLight.intensity = 0.8;
        this.fillLight.intensity = 0.3;
        this.backLight.intensity = 0.2;
        
        // ライティングコントロールを非表示
        document.getElementById('fbx-lighting').style.display = 'none';
        document.getElementById('vrm-lighting').style.display = 'none';
        
        // BVH情報を非表示
        document.getElementById('bvh-info').style.display = 'none';
        
        // コントロールを無効化
        this.disableControls();
    }
    
    displayBVHInfo() {
        if (!this.motionData) return;
        
        const fps = (1.0 / this.motionData.frameTime).toFixed(1);
        const frameCount = this.motionData.frameCount;
        const duration = (frameCount * this.motionData.frameTime).toFixed(2);
        
        document.getElementById('fpsValue').textContent = fps;
        document.getElementById('frameCountValue').textContent = frameCount;
        document.getElementById('durationValue').textContent = duration + '秒';
        document.getElementById('bvh-info').style.display = 'block';
    }
    
    normalizeModel(model) {
        // バウンディングボックスを計算
        const box = new THREE.Box3().setFromObject(model);
        const size = box.getSize(new THREE.Vector3());
        const center = box.getCenter(new THREE.Vector3());
        
        // 適切なサイズにスケール
        const maxDimension = Math.max(size.x, size.y, size.z);
        const targetSize = 150;
        const scale = targetSize / maxDimension;
        
        model.scale.setScalar(scale);
        
        // 中央に配置
        model.position.x = -center.x * scale;
        model.position.y = -center.y * scale;
        model.position.z = -center.z * scale;
        
        console.log(`Model normalized: scale=${scale.toFixed(3)}, size=${maxDimension.toFixed(2)} → ${targetSize}`);
    }
    
    readFile(file) {
        return new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = (e) => resolve(e.target.result);
            reader.onerror = (e) => reject(e);
            reader.readAsText(file);
        });
    }
    
    createSkeleton() {
        // 既存のスケルトングループを削除
        if (this.skeletonGroup) {
            this.scene.remove(this.skeletonGroup);
        }
        
        // 全オブジェクトを削除
        this.frameObjects.forEach(obj => this.scene.remove(obj));
        this.frameObjects = [];
        this.bones.clear();
        this.boneConnections = []; // 線の接続情報
        this.skeletonGroup = new THREE.Group(); // スケルトンをグループ化
        this.scene.add(this.skeletonGroup);
        
        // ボーンオブジェクトと接続情報を作成
        this.createBonesFromBVH(this.skeleton, null, new THREE.Vector3(0, 0, 0));
        this.createSkeletonLines();
        
        // 初期フレーム
        this.updateFrame(0);
        
        // スケールを正規化
        this.normalizeSkeletonScale();
    }
    
    normalizeSkeletonScale() {
        // 初期フレームで測定
        this.updateFrame(0);
        
        // 頭と足の位置を特定
        const headPosition = this.findHeadPosition();
        const footPosition = this.findLowestFootPosition();
        
        if (!headPosition || !footPosition) {
            console.warn('Could not find head or foot positions, using default scaling');
            this.fallbackScaling();
            return;
        }
        
        // 頭から足までの距離を計算
        const bodyHeight = headPosition.y - footPosition.y;
        
        if (bodyHeight <= 1) {
            console.warn('Invalid body height, using default scaling');
            this.fallbackScaling();
            return;
        }
        
        // 目標身長（すべてのモデルでこのサイズに統一）
        const targetHeight = 160;
        const scale = targetHeight / bodyHeight;
        
        // スケルトン全体をスケール
        this.skeletonGroup.scale.setScalar(scale);
        
        // 球（メッシュ）のサイズを元に戻す
        this.skeletonGroup.traverse((child) => {
            if (child.isMesh) {
                child.scale.setScalar(1 / scale);
            }
        });
        
        // 足の位置をより下に配置（画面下半分を活用）
        const scaledFootY = footPosition.y * scale;
        this.skeletonGroup.position.set(0, -scaledFootY - 40, 0);
        
        // スケール情報を保存
        this.skeletonScale = scale;
        
        console.log(`Skeleton scaled by ${scale.toFixed(3)} (height: ${bodyHeight.toFixed(2)} → ${targetHeight}), foot positioned at ground`);
    }
    
    
    findHeadPosition() {
        // Headボーンを探す
        const headBone = this.bones.get('Head');
        if (headBone && headBone.sphere) {
            return headBone.sphere.position.clone();
        }
        
        // Headがない場合、Neckを探す
        const neckBone = this.bones.get('Neck');
        if (neckBone && neckBone.sphere) {
            return neckBone.sphere.position.clone();
        }
        
        return null;
    }
    
    findLowestFootPosition() {
        let lowestY = Infinity;
        let lowestPosition = null;
        
        // 足関連のボーン名候補（通常の関節）
        const footBoneNames = [
            'LeftFoot', 'RightFoot', 'LeftToes', 'RightToes',
            'L_Foot', 'R_Foot', 'L_Toe', 'R_Toe',
            'left_foot', 'right_foot', 'left_toe', 'right_toe',
            'LeftUpperLeg', 'RightUpperLeg', 'LeftLowerLeg', 'RightLowerLeg'
        ];
        
        // 足関連のEnd Site名候補
        const footEndSiteNames = [
            'EndSite_LeftFoot', 'EndSite_RightFoot', 'EndSite_LeftToes', 'EndSite_RightToes',
            'EndSite_L_Foot', 'EndSite_R_Foot', 'EndSite_L_Toe', 'EndSite_R_Toe',
            'EndSite_left_foot', 'EndSite_right_foot', 'EndSite_left_toe', 'EndSite_right_toe'
        ];
        
        // 通常のボーンを検索
        footBoneNames.forEach(name => {
            const bone = this.bones.get(name);
            if (bone && bone.sphere && bone.sphere.position.y < lowestY) {
                lowestY = bone.sphere.position.y;
                lowestPosition = bone.sphere.position.clone();
            }
        });
        
        // End Siteも検索
        footEndSiteNames.forEach(name => {
            const bone = this.bones.get(name);
            if (bone && bone.sphere && bone.sphere.position.y < lowestY) {
                lowestY = bone.sphere.position.y;
                lowestPosition = bone.sphere.position.clone();
            }
        });
        
        // まだ見つからない場合、全ボーンから最も低い点を検索
        if (!lowestPosition) {
            this.bones.forEach(bone => {
                if (bone.sphere && bone.sphere.position.y < lowestY) {
                    lowestY = bone.sphere.position.y;
                    lowestPosition = bone.sphere.position.clone();
                }
            });
        }
        
        return lowestPosition;
    }
    
    findAbsoluteLowestPosition() {
        // 全ての関節とEnd Siteから絶対的に最も低い点を見つける
        let lowestY = Infinity;
        let lowestPosition = null;
        
        this.bones.forEach(bone => {
            if (bone.sphere && bone.sphere.position.y < lowestY) {
                lowestY = bone.sphere.position.y;
                lowestPosition = bone.sphere.position.clone();
            }
        });
        
        return lowestPosition;
    }
    
    fallbackScaling() {
        // バウンディングボックスベースのフォールバック
        const box = new THREE.Box3();
        this.skeletonGroup.traverse((child) => {
            if (child.isMesh) {
                box.expandByObject(child);
            }
        });
        
        if (box.isEmpty()) return;
        
        const size = box.getSize(new THREE.Vector3());
        const maxDimension = Math.max(size.x, size.y, size.z);
        const scale = 150 / maxDimension;
        
        this.skeletonGroup.scale.setScalar(scale);
        this.skeletonGroup.traverse((child) => {
            if (child.isMesh) {
                child.scale.setScalar(1 / scale);
            }
        });
        
        const center = box.getCenter(new THREE.Vector3());
        center.multiplyScalar(scale);
        this.skeletonGroup.position.set(-center.x, -center.y + 50, -center.z);
        
        this.skeletonScale = scale;
    }
    
    createBonesFromBVH(node, parentNode, parentPos) {
        // 現在の位置
        const pos = new THREE.Vector3(
            parentPos.x + node.offset[0],
            parentPos.y + node.offset[1], 
            parentPos.z + node.offset[2]
        );
        
        // チャンネルがあるノードのみ球を作成（動かない点を排除）
        if (node.channels && node.channels.length > 0 && node.type !== 'End Site') {
            const sphere = new THREE.Mesh(
                new THREE.SphereGeometry(1.5, 8, 6),
                new THREE.MeshBasicMaterial({ color: 0xff4444 })
            );
            sphere.position.copy(pos);
            this.skeletonGroup.add(sphere);
            this.frameObjects.push(sphere);
            
            this.bones.set(node.name, {
                sphere: sphere,
                node: node,
                channels: node.channels,
                position: pos.clone()
            });
        } else if (node.type === 'End Site') {
            // End Siteは小さな青い球
            const sphere = new THREE.Mesh(
                new THREE.SphereGeometry(0.8, 6, 4),
                new THREE.MeshBasicMaterial({ color: 0x4444ff })
            );
            sphere.position.copy(pos);
            this.skeletonGroup.add(sphere);
            this.frameObjects.push(sphere);
            
            const endSiteName = `EndSite_${parentNode.name}`;
            this.bones.set(endSiteName, {
                sphere: sphere,
                node: node,
                channels: [],
                position: pos.clone()
            });
        }
        
        // 接続情報を記録（親と子の関係）
        if (parentNode && node.name) {
            this.boneConnections.push({
                parent: parentNode.name,
                child: node.name,
                childType: node.type
            });
        } else if (parentNode && node.type === 'End Site') {
            this.boneConnections.push({
                parent: parentNode.name,
                child: `EndSite_${parentNode.name}`,
                childType: 'End Site'
            });
        }
        
        // 子を再帰処理
        node.children.forEach(child => {
            this.createBonesFromBVH(child, node, pos);
        });
    }
    
    createSkeletonLines() {
        // 接続情報に基づいて線を作成
        this.boneConnections.forEach(connection => {
            const parentBone = this.bones.get(connection.parent);
            const childBone = this.bones.get(connection.child);
            
            if (parentBone && childBone && parentBone.sphere && childBone.sphere) {
                const geometry = new THREE.BufferGeometry().setFromPoints([
                    parentBone.sphere.position,
                    childBone.sphere.position
                ]);
                
                const material = new THREE.LineBasicMaterial({ 
                    color: connection.childType === 'End Site' ? 0x0088ff : 0x00ff00 
                });
                const line = new THREE.Line(geometry, material);
                
                // 更新用の情報を保存
                line.userData = {
                    parentName: connection.parent,
                    childName: connection.child,
                    geometry: geometry
                };
                
                this.skeletonGroup.add(line);
                this.frameObjects.push(line);
            }
        });
    }
    
    updateSkeletonLines() {
        // 線の位置を更新
        this.frameObjects.forEach(obj => {
            if (obj instanceof THREE.Line && obj.userData) {
                const parentBone = this.bones.get(obj.userData.parentName);
                const childBone = this.bones.get(obj.userData.childName);
                
                if (parentBone && childBone && parentBone.sphere && childBone.sphere) {
                    obj.userData.geometry.setFromPoints([
                        parentBone.sphere.position,
                        childBone.sphere.position
                    ]);
                }
            }
        });
        
        // 球のサイズを一定に保つ（スケール後も）
        if (this.skeletonScale) {
            this.skeletonGroup.traverse((child) => {
                if (child.isMesh) {
                    child.scale.setScalar(1 / this.skeletonScale);
                }
            });
        }
        
        // 動的地面調整は削除（固定位置で浮かないように）
    }
    
    
    
    updateFrame(frameIndex) {
        if (!this.motionData || frameIndex >= this.motionData.frames.length) {
            return;
        }
        
        const frameData = this.motionData.frames[frameIndex];
        let channelIndex = 0;
        
        // End Siteの位置を更新するため
        const endSiteUpdates = new Map();
        
        // ボーン更新
        const updateBone = (node, parentTransform = new THREE.Matrix4()) => {
            const boneData = this.bones.get(node.name);
            
            // ローカル変換
            const local = new THREE.Matrix4();
            local.makeTranslation(node.offset[0], node.offset[1], node.offset[2]);
            
            // チャンネル適用
            if (node.channels) {
                for (let i = 0; i < node.channels.length; i++) {
                    const channel = node.channels[i];
                    const value = frameData[channelIndex++];
                    
                    if (channel === 'Xposition') local.multiply(new THREE.Matrix4().makeTranslation(value, 0, 0));
                    if (channel === 'Yposition') local.multiply(new THREE.Matrix4().makeTranslation(0, value, 0));
                    if (channel === 'Zposition') local.multiply(new THREE.Matrix4().makeTranslation(0, 0, value));
                    if (channel === 'Xrotation') local.multiply(new THREE.Matrix4().makeRotationX(THREE.MathUtils.degToRad(value)));
                    if (channel === 'Yrotation') local.multiply(new THREE.Matrix4().makeRotationY(THREE.MathUtils.degToRad(value)));
                    if (channel === 'Zrotation') local.multiply(new THREE.Matrix4().makeRotationZ(THREE.MathUtils.degToRad(value)));
                }
            } else {
                // チャンネルがない場合はスキップ
                channelIndex += node.channels ? node.channels.length : 0;
            }
            
            // ワールド位置
            const world = new THREE.Matrix4().multiplyMatrices(parentTransform, local);
            const pos = new THREE.Vector3().setFromMatrixPosition(world);
            
            // 球の位置を更新
            if (boneData && boneData.sphere) {
                boneData.sphere.position.copy(pos);
            }
            
            // End Siteの位置を計算して保存
            node.children.forEach(child => {
                if (child.type === 'End Site') {
                    const endSitePos = new THREE.Vector3(
                        pos.x + child.offset[0],
                        pos.y + child.offset[1],
                        pos.z + child.offset[2]
                    );
                    endSiteUpdates.set(`EndSite_${node.name}`, endSitePos);
                }
            });
            
            // 子処理
            node.children.forEach(child => updateBone(child, world));
        };
        
        updateBone(this.skeleton);
        
        // End Siteの位置を更新
        endSiteUpdates.forEach((pos, endSiteName) => {
            const endSiteBone = this.bones.get(endSiteName);
            if (endSiteBone && endSiteBone.sphere) {
                endSiteBone.sphere.position.copy(pos);
            }
        });
        
        // 線の位置を更新
        this.updateSkeletonLines();
    }
    
    
    enableControls() {
        // BVH以外ではアニメーションコントロールは無効
        const hasAnimation = this.currentModelType === 'bvh' || 
                           (this.mixer && this.mixer._actions.length > 0);
        
        document.getElementById('playBtn').disabled = !hasAnimation;
        document.getElementById('pauseBtn').disabled = !hasAnimation;
        document.getElementById('resetBtn').disabled = !hasAnimation;
        document.getElementById('speedControl').disabled = !hasAnimation;
    }
    
    disableControls() {
        document.getElementById('playBtn').disabled = true;
        document.getElementById('pauseBtn').disabled = true;
        document.getElementById('resetBtn').disabled = true;
        document.getElementById('speedControl').disabled = true;
    }
    
    play() {
        this.isPlaying = true;
        this.lastFrameTime = 0; // 時間をリセットしてスムーズに再開
    }
    
    pause() {
        this.isPlaying = false;
        this.lastFrameTime = 0;
    }
    
    reset() {
        this.currentFrame = 0;
        this.isPlaying = false;
        this.lastFrameTime = 0;
        this.frameAccumulator = 0;
        if (this.motionData) {
            this.updateFrame(0);
        }
    }
    
    animate(currentTime = 0) {
        requestAnimationFrame((time) => this.animate(time));
        
        if (this.isPlaying) {
            // 初回の場合、時間を初期化
            if (this.lastFrameTime === 0) {
                this.lastFrameTime = currentTime;
            }
            
            const deltaTime = (currentTime - this.lastFrameTime) / 1000 * this.playSpeed;
            this.lastFrameTime = currentTime;
            
            // BVHアニメーション
            if (this.currentModelType === 'bvh' && this.motionData) {
                const bvhFrameTimeMs = this.motionData.frameTime * 1000;
                this.frameAccumulator += (currentTime - (this.lastFrameTime - deltaTime * 1000));
                
                if (this.frameAccumulator >= bvhFrameTimeMs) {
                    const framesToAdvance = Math.floor(this.frameAccumulator / bvhFrameTimeMs);
                    this.currentFrame = (this.currentFrame + framesToAdvance) % this.motionData.frameCount;
                    this.frameAccumulator -= framesToAdvance * bvhFrameTimeMs;
                    this.updateFrame(Math.floor(this.currentFrame));
                }
            }
            
            // FBX/VRMアニメーション
            if (this.mixer) {
                this.mixer.update(deltaTime);
            }
        }
        
        this.renderer.render(this.scene, this.camera);
    }
    
    onWindowResize() {
        const canvas = this.renderer.domElement;
        this.camera.aspect = canvas.clientWidth / canvas.clientHeight;
        this.camera.updateProjectionMatrix();
        this.renderer.setSize(canvas.clientWidth, canvas.clientHeight);
    }
}

// Initialize the viewer when the page loads
window.addEventListener('DOMContentLoaded', () => {
    new ModelViewer();
});